function filterGoogleDriveFiles(files) {
  const allowedMimeTypes = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/jpg'
  ]);

  return (Array.isArray(files) ? files : [])
    .filter((file) => {
      const mimeType = String(file?.mimeType || '').toLowerCase();
      return Boolean(file?.id && file?.name && allowedMimeTypes.has(mimeType));
    })
    .map((file) => ({
      drive_file_id: file.id,
      file_name: file.name,
      file_stem: String(file.name).replace(/\.[^.]+$/, ''),
      mime_type: file.mimeType,
      drive_folder_id: Array.isArray(file.parents) ? file.parents[0] : null,
      source_url: file.webContentLink || `https://drive.google.com/uc?id=${file.id}`,
      thumbnail_url: file.thumbnailLink || null,
      metadata: file.imageMediaMetadata || {}
    }));
}

function shuffle(items) {
  const copy = Array.isArray(items) ? [...items] : [];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function cooldownFilter(mediaAssets, page, recentHistory, now = new Date()) {
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const pageCooldownHours = Number(page?.cooldown_hours || 72);
  const pageHistory = new Map(
    (Array.isArray(recentHistory) ? recentHistory : [])
      .filter((row) => row?.page_id === page?.id)
      .map((row) => [row.media_asset_id || row.drive_file_id, row])
  );

  return (Array.isArray(mediaAssets) ? mediaAssets : []).filter((asset) => {
    if (!asset || asset.exhausted || asset.status === 'disabled') return false;
    if (asset.cooldown_until && new Date(asset.cooldown_until).getTime() > currentTime) return false;

    const historyKey = asset.id || asset.drive_file_id;
    const previous = pageHistory.get(historyKey);
    if (!previous?.posted_at) return true;

    const elapsedMs = currentTime - new Date(previous.posted_at).getTime();
    return elapsedMs >= pageCooldownHours * 60 * 60 * 1000;
  });
}

function randomUniqueAssignment(pages, eligibleMedia, cycleSeed = Date.now()) {
  const seededPages = shuffle(
    (Array.isArray(pages) ? pages : []).map((page, index) => ({ page, sortKey: `${cycleSeed}-${index}-${page.id}` }))
  ).map((entry) => entry.page);

  const used = new Set();
  const mediaByFolder = (Array.isArray(eligibleMedia) ? eligibleMedia : []).reduce((acc, media) => {
    const key = media.drive_folder_id || 'shared';
    if (!acc[key]) acc[key] = [];
    acc[key].push(media);
    return acc;
  }, {});

  const sharedPool = [...(mediaByFolder.shared || []), ...(mediaByFolder.drive_shared || [])];

  return seededPages.map((page, index) => {
    const folderPool = mediaByFolder[page.drive_folder_id] || [];
    const candidate = shuffle([...folderPool, ...sharedPool]).find((media) => !used.has(media.drive_file_id)) || null;

    if (candidate) used.add(candidate.drive_file_id);

    return {
      page,
      image: candidate,
      assignment_status: candidate ? 'assigned' : 'skipped_no_media',
      delay_seconds: staggerDelayCalculation(page, index)
    };
  });
}

function aiPayloadBuilder({ image, page, promptTemplate }) {
  const template = promptTemplate || [
    'Return strict JSON only.',
    'Keys: hook, caption, cta, hashtags, confidence.',
    `Image filename: ${image?.file_name || 'unknown'}`,
    `Folder context: ${image?.folder_context || page?.drive_folder_name || 'general'}`,
    `Page niche: ${page?.page_niche || 'general'}`,
    `Language: ${page?.language || 'en'}`,
    `Tone: ${page?.tone || 'neutral'}`
  ].join('\n');

  return {
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: 0.8,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are a social media caption generator. Return only valid JSON.'
      },
      {
        role: 'user',
        content: template
      }
    ]
  };
}

function aiJsonValidator(rawResponse, language = 'en', pageName = 'Page') {
  let parsed;
  try {
    const content = rawResponse?.choices?.[0]?.message?.content || rawResponse?.caption_json || '{}';
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    parsed = null;
  }

  const fallback = language === 'th'
    ? {
        hook: `โพสต์ใหม่จาก ${pageName}`,
        caption: 'ภาพนี้พร้อมเผยแพร่แล้ว',
        cta: 'ติดตามรายละเอียดเพิ่มเติมได้เลย',
        hashtags: ['#โพสต์อัตโนมัติ'],
        confidence: 0.3
      }
    : {
        hook: `Fresh post from ${pageName}`,
        caption: 'This image is ready to publish.',
        cta: 'Follow for more updates.',
        hashtags: ['#automation'],
        confidence: 0.3
      };

  const payload = parsed && (parsed.caption || parsed.hook) ? parsed : fallback;
  payload.hashtags = Array.isArray(payload.hashtags) ? payload.hashtags.filter(Boolean).slice(0, 8) : [];
  payload.confidence = Number.isFinite(Number(payload.confidence)) ? Math.max(0, Math.min(1, Number(payload.confidence))) : fallback.confidence;
  payload.final_caption_text = [payload.hook, payload.caption, payload.cta, payload.hashtags.join('\n')].filter(Boolean).join('\n\n').slice(0, 2200);

  return payload;
}

function facebookPayloadBuilder({ page, image, captionPayload }) {
  if (!page?.page_id) throw new Error('Missing page.page_id');
  if (!page?.page_access_token) throw new Error('Missing page.page_access_token');
  if (!image?.source_url) throw new Error('Missing image.source_url');

  return {
    url: `${process.env.FB_API_BASE || 'https://graph.facebook.com/v20.0'}/${page.page_id}/photos`,
    method: 'POST',
    form: {
      url: image.source_url,
      caption: String(captionPayload?.final_caption_text || '').slice(0, 2200),
      access_token: page.page_access_token
    }
  };
}

function staggerDelayCalculation(page, index) {
  const stagger = Number(page?.stagger_seconds ?? process.env.STAGGER_BASE_SECONDS ?? 45);
  const safeIndex = Number.isFinite(index) ? Math.max(0, index) : 0;
  return Math.max(0, stagger * safeIndex);
}

module.exports = {
  filterGoogleDriveFiles,
  shuffle,
  cooldownFilter,
  randomUniqueAssignment,
  aiPayloadBuilder,
  aiJsonValidator,
  facebookPayloadBuilder,
  staggerDelayCalculation
};
