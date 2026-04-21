import { createAutoPostAiRecords } from "@/lib/services/automation-records-ai";
import { extractExactTextFromImage, extractPrimaryCreativeTextFromImage, generateFacebookContent } from "@/lib/services/ai";
import { fetchDriveImageBinary, fetchImagesFromFolder } from "@/lib/services/google-drive";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { enqueuePostJobsForPost, processQueuedJobs } from "@/lib/services/queue";
import { randomItem } from "@/lib/utils";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
import { Job } from "@/models/Job";
import { Post } from "@/models/Post";

type AutoPostStatus = "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
type JobStatus = "pending" | "processing" | "posted" | "failed";

type LeanAutoPostConfig = {
  _id: string;
  userId: string;
  enabled: boolean;
  folderId: string;
  folderName?: string;
  targetPageIds: string[];
  intervalMinutes: number;
  minRandomDelayMinutes?: number;
  maxRandomDelayMinutes?: number;
  maxPostsPerDay?: number;
  maxPostsPerPagePerDay?: number;
  captionStrategy: "manual" | "ai" | "hybrid";
  automationMode?: "standard" | "multi-image-ai";
  multiImageCountMode?: "4" | "5" | "6-10";
  captions: string[];
  hashtags?: string[];
  aiPrompt?: string;
  postingWindowStart?: string;
  postingWindowEnd?: string;
  language?: "th" | "en";
  nextRunAt: Date;
  lastRunAt?: Date;
  usedImageIds?: string[];
  dailyImageUsageDate?: string | null;
  dailyUsedImageIds?: string[];
  recentImageUsage?: Array<{ imageId: string; usedAt: Date | string }>;
};

type LeanDriveConnection = {
  accessToken: string;
};

type DriveImage = {
  id: string;
  name: string;
  mimeType?: string;
};

type RecentImageUsageEntry = {
  imageId: string;
  usedAt: Date;
};

type AutoPostRunSource = "manual-start" | "schedule";

type QueueAutoPostsOptions = {
  source: AutoPostRunSource;
  immediate: boolean;
};

type QueueAutoPostsResult = {
  queued: number;
  workflowId: string;
  workflowRunId: string;
  contentItemId: string;
};

const AUTO_POST_BATCH_PAGE_SPACING_MINUTES = Number(process.env.AUTO_POST_PAGE_SPACING_MINUTES ?? "10");
const BANGKOK_UTC_OFFSET_HOURS = 7;

function parseClockToMinutes(value?: string | null) {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function getBangkokDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour"),
    minute: getPart("minute")
  };
}

function toBangkokDate(parts: { year: number; month: number; day: number }, minutesTotal: number, dayOffset = 0) {
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hours - BANGKOK_UTC_OFFSET_HOURS, minutes));
}

function isWithinPostingWindow(date: Date, start?: string | null, end?: string | null) {
  const startMinutes = parseClockToMinutes(start);
  const endMinutes = parseClockToMinutes(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
    return true;
  }

  const parts = getBangkokDateParts(date);
  const currentMinutes = parts.hour * 60 + parts.minute;

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function getNextWindowStart(date: Date, start?: string | null, end?: string | null) {
  const startMinutes = parseClockToMinutes(start);
  const endMinutes = parseClockToMinutes(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
    return date;
  }

  const parts = getBangkokDateParts(date);
  const currentMinutes = parts.hour * 60 + parts.minute;

  if (startMinutes < endMinutes) {
    if (currentMinutes < startMinutes) {
      return toBangkokDate(parts, startMinutes);
    }
    return toBangkokDate(parts, startMinutes, 1);
  }

  if (currentMinutes > endMinutes && currentMinutes < startMinutes) {
    return toBangkokDate(parts, startMinutes);
  }

  return date;
}

function getWindowEndForStart(startDate: Date, end?: string | null) {
  const endMinutes = parseClockToMinutes(end);
  if (endMinutes === null) {
    return null;
  }

  const startParts = getBangkokDateParts(startDate);
  const startMinutes = startParts.hour * 60 + startParts.minute;
  const dayOffset = startMinutes <= endMinutes ? 0 : 1;
  return toBangkokDate(startParts, endMinutes, dayOffset);
}

function fitBatchStartToPostingWindow(
  requestedStart: Date,
  pageCount: number,
  windowStart?: string | null,
  windowEnd?: string | null
) {
  let candidate = isWithinPostingWindow(requestedStart, windowStart, windowEnd)
    ? requestedStart
    : getNextWindowStart(requestedStart, windowStart, windowEnd);

  const spacingMs = Math.max(0, AUTO_POST_BATCH_PAGE_SPACING_MINUTES) * 60 * 1000;
  const batchDurationMs = Math.max(0, pageCount - 1) * spacingMs;

  while (true) {
    const windowEndDate = getWindowEndForStart(candidate, windowEnd);
    if (!windowEndDate) {
      return candidate;
    }

    const batchEnd = new Date(candidate.getTime() + batchDurationMs);
    if (batchEnd <= windowEndDate) {
      return candidate;
    }

    candidate = getNextWindowStart(new Date(candidate.getTime() + 24 * 60 * 60 * 1000), windowStart, windowEnd);
  }
}

function getNextAutoRun(intervalMinutes: number, windowStart?: string | null, windowEnd?: string | null, baseDate = new Date()) {
  const minutes = [15, 30, 60, 120].includes(intervalMinutes) ? intervalMinutes : 60;
  const candidate = new Date(baseDate.getTime() + minutes * 60 * 1000);
  return isWithinPostingWindow(candidate, windowStart, windowEnd)
    ? candidate
    : getNextWindowStart(candidate, windowStart, windowEnd);
}

function getRandomDelayMinutes(minMinutes = 0, maxMinutes = 0) {
  const min = Math.max(0, minMinutes);
  const max = Math.max(min, maxMinutes);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomizeOrder<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function normalizeCycleUsedImageIds(images: DriveImage[], usedImageIds: string[] = []) {
  if (!usedImageIds.length) {
    return [];
  }

  const validIds = new Set(images.map((image) => image.id));
  return usedImageIds.filter((imageId) => validIds.has(imageId));
}

function stripNumericSuffix(value: string) {
  return value
    .replace(/[\s_-]*\(\d+\)$/g, "")
    .replace(/[\s_-]*\d+$/g, "")
    .replace(/[\s_-]+$/g, "")
    .trim();
}

function normalizeImageClusterKey(name: string) {
  const base = stripNumericSuffix(stripFileExtension(name).toLowerCase());
  return base
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .trim();
}

function pruneRecentImageUsage(history: Array<{ imageId: string; usedAt: Date | string }> = [], now = new Date()) {
  const threshold = now.getTime() - 24 * 60 * 60 * 1000;
  return history
    .map((entry) => ({
      imageId: entry.imageId,
      usedAt: entry.usedAt instanceof Date ? entry.usedAt : new Date(entry.usedAt)
    }))
    .filter((entry) => !Number.isNaN(entry.usedAt.getTime()) && entry.usedAt.getTime() > threshold);
}

function getAvailableImagesForCycle(
  images: DriveImage[],
  currentDayKey: string,
  persistedDayKey?: string | null,
  dailyUsedImageIds: string[] = [],
  recentImageUsage: Array<{ imageId: string; usedAt: Date | string }> = [],
  usedImageIds: string[] = []
) {
  const activeDailyUsedImageIds = persistedDayKey === currentDayKey ? dailyUsedImageIds : [];
  const prunedRecentUsage = pruneRecentImageUsage(recentImageUsage);
  const cycleUsedImageIds = normalizeCycleUsedImageIds(images, usedImageIds);
  const permanentlyBlockedIds = new Set<string>([
    ...activeDailyUsedImageIds,
    ...prunedRecentUsage.map((entry) => entry.imageId)
  ]);

  let availableImages = randomizeOrder(
    images.filter((image) => !permanentlyBlockedIds.has(image.id) && !cycleUsedImageIds.includes(image.id))
  );
  let nextUsedImageIds = cycleUsedImageIds;

  if (!availableImages.length) {
    availableImages = randomizeOrder(images.filter((image) => !permanentlyBlockedIds.has(image.id)));
    nextUsedImageIds = [];
  }

  return {
    availableImages,
    activeDailyUsedImageIds,
    prunedRecentUsage,
    nextUsedImageIds
  };
}

function getMultiImageTargetCount(mode: "4" | "5" | "6-10" = "4", availableCount = Number.POSITIVE_INFINITY) {
  if (mode === "5") {
    return availableCount >= 5 ? 5 : 0;
  }
  if (mode === "6-10") {
    const max = Math.min(10, availableCount);
    if (max < 6) return 0;
    return Math.floor(Math.random() * (max - 6 + 1)) + 6;
  }
  return availableCount >= 4 ? 4 : 0;
}

function selectSimilarImageGroup(availableImages: DriveImage[], count: number) {
  if (availableImages.length < count) {
    throw new Error(`Not enough eligible images to build a ${count}-image post right now.`);
  }

  const groups = new Map<string, DriveImage[]>();
  for (const image of availableImages) {
    const key = normalizeImageClusterKey(image.name) || image.id;
    const existing = groups.get(key) ?? [];
    existing.push(image);
    groups.set(key, existing);
  }

  const preferredGroups = Array.from(groups.values())
    .filter((group) => group.length >= count)
    .sort((left, right) => right.length - left.length);

  if (preferredGroups.length) {
    return randomizeOrder(randomItem(preferredGroups)).slice(0, count);
  }

  return availableImages.slice(0, count);
}

function getBangkokDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function buildDailyImageSelectionPlan(
  images: DriveImage[],
  pageCount: number,
  currentDayKey: string,
  persistedDayKey?: string | null,
  dailyUsedImageIds: string[] = [],
  recentImageUsage: Array<{ imageId: string; usedAt: Date | string }> = [],
  usedImageIds: string[] = []
) {
  if (!images.length || pageCount <= 0) {
    return {
      chosenImages: [] as DriveImage[],
      nextDailyUsedImageIds: persistedDayKey === currentDayKey ? dailyUsedImageIds : [],
      activeDayKey: currentDayKey,
      nextRecentImageUsage: pruneRecentImageUsage(recentImageUsage),
      nextUsedImageIds: normalizeCycleUsedImageIds(images, usedImageIds)
    };
  }

  const activeDayKey = currentDayKey;
  const { availableImages, activeDailyUsedImageIds, prunedRecentUsage, nextUsedImageIds } = getAvailableImagesForCycle(
    images,
    currentDayKey,
    persistedDayKey,
    dailyUsedImageIds,
    recentImageUsage,
    usedImageIds
  );

  if (availableImages.length < pageCount) {
    throw new Error(
      `Not enough unused images left for today. Available: ${availableImages.length}, required: ${pageCount}. Add more images or wait until tomorrow.`
    );
  }

  const chosenImages = availableImages.slice(0, pageCount);
  return {
    chosenImages,
    nextDailyUsedImageIds: [...activeDailyUsedImageIds, ...chosenImages.map((image) => image.id)],
    activeDayKey,
    nextRecentImageUsage: [
      ...prunedRecentUsage,
      ...chosenImages.map((image) => ({ imageId: image.id, usedAt: new Date() }))
    ],
    nextUsedImageIds: [...nextUsedImageIds, ...chosenImages.map((image) => image.id)]
  };
}

async function updateAutoPostState(
  configId: string,
  updates: Partial<{
    autoPostStatus: AutoPostStatus;
    jobStatus: JobStatus;
    lastRunAt: Date;
    nextRunAt: Date;
    lastError: string | null;
    retryCount: number;
    lastPostId: unknown;
    lastSelectedImageId: string | null;
    usedImageIds: string[];
    dailyImageUsageDate: string | null;
    dailyUsedImageIds: string[];
    recentImageUsage: RecentImageUsageEntry[];
    enabled: boolean;
    lastStatus: "pending" | "posted" | "failed" | "paused";
    lastWorkflowId: unknown;
    lastWorkflowRunId: unknown;
    lastContentItemId: unknown;
  }>
) {
  await AutoPostAiConfig.findByIdAndUpdate(configId, updates);
}

async function countSuccessfulAutoPostsToday(userId: string, configId: string, pageId?: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const query: Record<string, unknown> = {
    userId,
    status: "success",
    createdAt: { $gte: startOfDay },
    "payload.autoPostAiConfigId": configId
  };

  if (pageId) {
    query.targetPageId = pageId;
  }

  return Job.countDocuments(query);
}

function stripFileExtension(value: string) {
  return value.replace(/\.[a-z0-9]+$/i, "").trim();
}

function summarizeImageStyleLabel(name: string) {
  return stripNumericSuffix(stripFileExtension(name))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHashtags(hashtags?: string[]) {
  return (hashtags ?? [])
    .map((hashtag) => hashtag.trim())
    .filter(Boolean)
    .map((hashtag) => (hashtag.startsWith("#") ? hashtag : `#${hashtag}`));
}

function appendHashtags(caption: string, hashtags?: string[]) {
  const normalizedHashtags = normalizeHashtags(hashtags);
  if (!normalizedHashtags.length) {
    return caption;
  }

  const trimmedCaption = caption.trim();
  const hashtagBlock = normalizedHashtags.join(" ");
  return trimmedCaption ? `${trimmedCaption}\n\n${hashtagBlock}` : hashtagBlock;
}

async function buildCaption(config: LeanAutoPostConfig, image: DriveImage, driveAccessToken: string) {
  const manualCaption = config.captions.length > 0 ? randomItem(config.captions) : "";
  const strategy = config.captionStrategy ?? "hybrid";
  const keyword = config.aiPrompt?.trim() || image.name || config.folderName || "Google Drive";

  if (strategy === "manual") {
    return appendHashtags(manualCaption || `Fresh content from ${config.folderName || "Google Drive"}`, config.hashtags);
  }

  if (strategy === "ai") {
    try {
      const imageFile = await fetchDriveImageBinary(driveAccessToken, image.id);
      const primaryText = await extractPrimaryCreativeTextFromImage(imageFile.bytes, imageFile.mimeType);
      if (primaryText) {
        return appendHashtags(primaryText, config.hashtags);
      }

      const extractedText = await extractExactTextFromImage(imageFile.bytes, imageFile.mimeType);
      if (extractedText) {
        return appendHashtags(extractedText, config.hashtags);
      }
    } catch {
      // Fall through to the explicit failure below.
    }

    throw new Error("AI-only caption mode could not extract readable text from the selected image");
  }
  let extractedText = "";
  try {
    const imageFile = await fetchDriveImageBinary(driveAccessToken, image.id);
    extractedText = await extractExactTextFromImage(imageFile.bytes, imageFile.mimeType);
  } catch {
    // Best-effort only for prompt grounding.
  }

  const sourceParts = [
    manualCaption ? `Manual caption draft:\n${manualCaption}` : "",
    extractedText ? `Text found in image:\n${extractedText}` : "",
    image.name ? `Image file name:\n${stripFileExtension(image.name)}` : "",
    config.folderName ? `Google Drive folder:\n${config.folderName}` : ""
  ].filter(Boolean);

  try {
    const variants = await generateFacebookContent(
      keyword,
      {
        persona: {
        audience: "general audience",
        contentStyle: "social post",
        tone: "friendly",
        pageName: "Auto Post"
        },
        userId: config.userId,
        customPrompt: config.aiPrompt,
        sourceText: sourceParts.join("\n\n"),
        sourceLabel: "manual draft, OCR text, and image context"
      }
    );

    const chosen = variants?.length ? randomItem(variants) : null;
    if (chosen) {
      return appendHashtags([chosen.caption, chosen.hashtags.join(" ")].filter(Boolean).join("\n\n"), config.hashtags);
    }
  } catch {
    // Fall back to manual or default text.
  }

  if (manualCaption) {
    return appendHashtags(manualCaption, config.hashtags);
  }

  if (extractedText) {
    return appendHashtags(extractedText, config.hashtags);
  }

  return appendHashtags(`Fresh update from ${config.folderName || "your Google Drive"}`, config.hashtags);
}

async function buildMultiImageCaption(config: LeanAutoPostConfig, images: DriveImage[], driveAccessToken: string) {
  const sampleImages = images.slice(0, Math.min(images.length, 4));
  const sourceChunks: string[] = [];

  for (const [index, image] of sampleImages.entries()) {
    let creativeText = "";
    let exactText = "";

    try {
      const imageFile = await fetchDriveImageBinary(driveAccessToken, image.id);
      creativeText = await extractPrimaryCreativeTextFromImage(imageFile.bytes, imageFile.mimeType);
      exactText = creativeText ? "" : await extractExactTextFromImage(imageFile.bytes, imageFile.mimeType);
    } catch {
      // Keep caption generation resilient even if one image cannot be analyzed.
    }

    const parts = [
      creativeText ? `ภาพที่ ${index + 1}: ธีมหลักที่เห็นคือ ${creativeText}` : "",
      exactText ? `ภาพที่ ${index + 1}: ข้อความสำคัญบนภาพคือ ${exactText}` : "",
      !creativeText && !exactText && summarizeImageStyleLabel(image.name)
        ? `ภาพที่ ${index + 1}: ฟีลโดยรวมใกล้เคียงกับ ${summarizeImageStyleLabel(image.name)}`
        : ""
    ].filter(Boolean);

    if (parts.length) {
      sourceChunks.push(parts.join("\n"));
    }
  }

  const keyword = `${config.folderName || "Google Drive"} photo set`;
  const builtInPrompt =
    `เขียนแคปชั่น Facebook ภาษาไทยสำหรับโพสต์หลายภาพ ให้เป็นโพสต์สำเร็จรูปพร้อมใช้จริง

สไตล์ที่ต้องการ:
- น่ารัก ละมุน เป็นกันเอง
- ชวนหยุดดู ชวนอ่านต่อ ชวนเซฟ ชวนคอมเมนต์
- อ่านลื่นแบบเพจคอนเทนต์สวยๆ
- ใช้อีโมจิพอดีๆ ได้ แต่ไม่เยอะเกิน

โครงสร้างที่ต้องการทุกโพสต์:
1. เปิดด้วย hook แบบชวนหยุดอ่านทันที
2. เกริ่นว่ารวมไอเดีย/รวมแบบอะไร
3. มีประโยคชวนให้ดูทีละรูป
4. ไล่เป็น:
แบบ 1 :
แบบ 2 :
แบบ 3 :
แบบ 4 :
ถ้ามีมากกว่า 4 รูปให้เขียนต่อจนครบ
5. ปิดท้ายด้วย CTA ให้คอมเมนต์ / เซฟ / แชร์

กติกาสำคัญ:
- ห้ามพูดถึงชื่อไฟล์ภาพ
- ห้ามพูดถึงการวิเคราะห์ภาพ
- ห้ามพูดถึงคำว่า OCR, source, prompt, ภาพนี้น่าจะ, รูปนี้อาจจะ
- ห้ามเขียนเหมือนโน้ตหลังบ้านหรือบรีฟงาน
- ห้ามถามกลับเพื่อขอข้อมูลเพิ่ม
- ต้องอิงจากรายละเอียดในภาพจริงเท่านั้น
- ถ้ารายละเอียดบางรูปไม่ชัด ให้สรุปจากธีมที่เห็น โดยยังต้องเขียนให้อ่านเหมือนโพสต์จริง`;
  const customPrompt = [builtInPrompt, config.aiPrompt?.trim() || ""].filter(Boolean).join("\n\n");

  try {
    const variants = await generateFacebookContent(keyword, {
      userId: config.userId,
      customPrompt,
      sourceText: sourceChunks.join("\n\n"),
      sourceLabel: "selected image set details"
    });
    const chosen = variants?.length ? randomItem(variants) : null;
    if (chosen) {
      return appendHashtags([chosen.caption, chosen.hashtags.join(" ")].filter(Boolean).join("\n\n"), config.hashtags);
    }
  } catch {
    // Fall back below.
  }

  return appendHashtags(
    `รวมภาพเด่นจาก ${config.folderName || "คลังรูป"} ชุดนี้ไว้ให้แล้ว ลองดูทีละภาพแล้วจะเห็นธีมหลักชัดขึ้นแบบครบกว่าการดูโพสต์เดี่ยว`,
    config.hashtags
  );
}

async function queueAutoPostsForConfig(config: LeanAutoPostConfig, options: QueueAutoPostsOptions): Promise<QueueAutoPostsResult> {
  const triggeredAt = new Date();
  const nextRunAt = getNextAutoRun(config.intervalMinutes, config.postingWindowStart, config.postingWindowEnd, triggeredAt);

  await updateAutoPostState(config._id, {
    autoPostStatus: "running",
    jobStatus: "pending",
    lastStatus: "pending",
    lastError: null,
    retryCount: 0,
    lastRunAt: triggeredAt,
    nextRunAt
  });

  if (!config.targetPageIds.length) {
    throw new Error("No Facebook pages selected for Auto Post");
  }

  const eligiblePageIds: string[] = [];
  for (const pageId of config.targetPageIds) {
    eligiblePageIds.push(pageId);
  }

  const driveConnection = (await ensureValidGoogleDriveConnection(config.userId)) as LeanDriveConnection;
  await ensureValidFacebookConnection(config.userId);

  const folderPayload = await fetchImagesFromFolder(driveConnection.accessToken, config.folderId || "root");
  const images = folderPayload.files.filter((file) => (file.mimeType || "").includes("image/"));

  if (!images.length) {
    await updateAutoPostState(config._id, {
      autoPostStatus: "failed",
      jobStatus: "failed",
      lastStatus: "failed",
      lastError: "No JPG or PNG images found in the selected folder",
      lastRunAt: triggeredAt,
      nextRunAt,
      retryCount: 0
    });

    throw new Error("No JPG or PNG images found in the selected folder");
  }

  const records = await createAutoPostAiRecords({
    userId: config.userId,
    configId: config._id,
    folderId: config.folderId,
    folderName: config.folderName || "Google Drive",
    pageIds: eligiblePageIds,
    intervalMinutes: config.intervalMinutes,
    captionStrategy: config.captionStrategy,
    captions: config.captions,
    aiPrompt: config.aiPrompt || "",
    language: config.language || "th",
    source: options.source,
    triggeredAt: triggeredAt.toISOString()
  });

  let queued = 0;
  let lastPostId: unknown = null;
  let lastSelectedImageId: string | null = null;
  const dayKey = getBangkokDayKey(triggeredAt);
  const automationMode = config.automationMode ?? "standard";
  const batchDelayMinutes = options.immediate ? 0 : getRandomDelayMinutes(config.minRandomDelayMinutes ?? 0, config.maxRandomDelayMinutes ?? 0);
  const batchRequestedStartAt = new Date(Date.now() + batchDelayMinutes * 60 * 1000);
  const batchStartAt = fitBatchStartToPostingWindow(
    batchRequestedStartAt,
    eligiblePageIds.length,
    config.postingWindowStart,
    config.postingWindowEnd
  );

  const selectedImageIdsForRun: string[] = [];
  let nextDailyUsedImageIds = config.dailyImageUsageDate === dayKey ? [...(config.dailyUsedImageIds ?? [])] : [];
  let nextRecentImageUsage = pruneRecentImageUsage(config.recentImageUsage ?? [], triggeredAt);
  let nextUsedImageIds = normalizeCycleUsedImageIds(images, config.usedImageIds ?? []);
  let sharedMultiImageSelection: DriveImage[] | null = null;
  let sharedMultiImageCaption: string | null = null;

  for (let index = 0; index < eligiblePageIds.length; index += 1) {
    const pageId = eligiblePageIds[index];
    let selectedImages: DriveImage[] = [];

    if (automationMode === "multi-image-ai") {
      if (!sharedMultiImageSelection) {
        const { availableImages, nextUsedImageIds: rotatedUsedImageIds } = getAvailableImagesForCycle(
          images,
          dayKey,
          dayKey,
          nextDailyUsedImageIds,
          nextRecentImageUsage,
          nextUsedImageIds
        );
        const count = getMultiImageTargetCount(config.multiImageCountMode ?? "4", availableImages.length);
        if (!count) {
          throw new Error(
            `Not enough eligible images to build the selected multi-image post size. Available right now: ${availableImages.length}, required: ${config.multiImageCountMode === "5" ? 5 : config.multiImageCountMode === "6-10" ? "6-10" : 4}.`
          );
        }

        sharedMultiImageSelection = selectSimilarImageGroup(availableImages, count);
        sharedMultiImageCaption = await buildMultiImageCaption(config, sharedMultiImageSelection, driveConnection.accessToken);
        nextUsedImageIds = [...rotatedUsedImageIds, ...sharedMultiImageSelection.map((image) => image.id)];
        nextDailyUsedImageIds = [...nextDailyUsedImageIds, ...sharedMultiImageSelection.map((image) => image.id)];
        nextRecentImageUsage = [
          ...nextRecentImageUsage,
          ...sharedMultiImageSelection.map((image) => ({ imageId: image.id, usedAt: triggeredAt }))
        ];
      }

      selectedImages = sharedMultiImageSelection;
    } else {
      const plan = buildDailyImageSelectionPlan(
        images,
        1,
        dayKey,
        dayKey,
        nextDailyUsedImageIds,
        nextRecentImageUsage,
        nextUsedImageIds
      );
      selectedImages = plan.chosenImages;
      nextUsedImageIds = plan.nextUsedImageIds;
    }

    if (!selectedImages.length) {
      throw new Error("No eligible images available for the next auto-post run");
    }

    const selectedImageIds = selectedImages.map((image) => image.id);
    if (automationMode !== "multi-image-ai") {
      nextDailyUsedImageIds = [...nextDailyUsedImageIds, ...selectedImageIds];
      nextRecentImageUsage = [
        ...nextRecentImageUsage,
        ...selectedImageIds.map((imageId) => ({ imageId, usedAt: triggeredAt }))
      ];
    }
    selectedImageIdsForRun.push(...selectedImageIds);

    const primaryImage = selectedImages[0];
    const caption =
      automationMode === "multi-image-ai"
        ? sharedMultiImageCaption ?? await buildMultiImageCaption(config, selectedImages, driveConnection.accessToken)
        : await buildCaption(config, primaryImage, driveConnection.accessToken);
    const normalizedHashtags = normalizeHashtags(config.hashtags);
    const startAt = new Date(batchStartAt.getTime() + index * AUTO_POST_BATCH_PAGE_SPACING_MINUTES * 60 * 1000);

    const post = await Post.create({
      userId: config.userId,
      title: `Auto Post ${pageId} ${triggeredAt.toISOString()}`,
      content: caption,
      hashtags: normalizedHashtags,
      imageUrls: selectedImageIds.map((imageId) => `drive:${imageId}`),
      targetPageIds: [pageId],
      randomizeImages: false,
      randomizeCaption: false,
      postingMode: "broadcast",
      variants: [],
      status: "scheduled"
    });

    lastPostId = post._id;
    lastSelectedImageId = primaryImage.id;

    const queuedForPost = await enqueuePostJobsForPost(config.userId, String(post._id), {
      applyRandomDelay: false,
      startAt,
      payloadExtras: {
        autoPostAiConfigId: config._id,
        autoSource: "google-drive",
        automationMode,
        selectedFolderId: config.folderId,
        selectedImageId: primaryImage.id,
        selectedImageIds,
        scheduledDelayMinutes: batchDelayMinutes + index * AUTO_POST_BATCH_PAGE_SPACING_MINUTES,
        workflowId: records.workflowId,
        workflowRunId: records.workflowRunId,
        contentItemId: records.contentItemId
      }
    });

    queued += queuedForPost;
  }

  await updateAutoPostState(config._id, {
    autoPostStatus: "posting",
    jobStatus: "pending",
    lastStatus: "pending",
    lastError: null,
    lastRunAt: triggeredAt,
    nextRunAt,
    retryCount: 0,
    lastPostId,
    lastSelectedImageId,
    usedImageIds: nextUsedImageIds,
    dailyImageUsageDate: dayKey,
    dailyUsedImageIds: nextDailyUsedImageIds,
    recentImageUsage: nextRecentImageUsage,
    lastWorkflowId: records.workflowId,
    lastWorkflowRunId: records.workflowRunId,
    lastContentItemId: records.contentItemId
  });

  await logAction({
    userId: config.userId,
    type: "queue",
    level: "info",
    message: options.source === "manual-start" ? "Auto Post started in-app" : "Scheduled Auto Post queued",
    relatedPostId: lastPostId ? String(lastPostId) : undefined,
    metadata: {
      autoPostAi: true,
      autoPostAiConfigId: config._id,
      folderId: config.folderId,
      source: options.source,
      queued,
      eligiblePageIds,
      postingWindowStart: config.postingWindowStart ?? null,
      postingWindowEnd: config.postingWindowEnd ?? null,
      lastSelectedImageId,
      selectedImageIds: selectedImageIdsForRun,
      automationMode,
      multiImageCountMode: config.multiImageCountMode ?? "4",
      workflowId: records.workflowId,
      workflowRunId: records.workflowRunId,
      contentItemId: records.contentItemId
    }
  });

  return {
    queued,
    ...records
  };
}

export async function processAutoPostAiConfigNow(userId: string, configId: string) {
  const config = (await AutoPostAiConfig.findOne({ _id: configId, userId }).lean()) as unknown as LeanAutoPostConfig | null;

  if (!config) {
    throw new Error("Auto Post settings not found");
  }

  const result = await queueAutoPostsForConfig(config, {
    source: "manual-start",
    immediate: true
  });

  const processedJobs = await processQueuedJobs(Math.max(config.targetPageIds.length, 1));

  return {
    ...result,
    processedJobs
  };
}

export async function processDueAutoPostAiConfigs() {
  const configs = (await AutoPostAiConfig.find({
    enabled: true,
    autoPostStatus: { $nin: ["paused"] },
    nextRunAt: { $lte: new Date() }
  })
    .sort({ nextRunAt: 1 })
    .lean()) as unknown as LeanAutoPostConfig[];

  let processed = 0;

  for (const config of configs) {
    try {
      if (!isWithinPostingWindow(new Date(), config.postingWindowStart, config.postingWindowEnd)) {
        await updateAutoPostState(config._id, {
          autoPostStatus: "waiting",
          jobStatus: "pending",
          lastStatus: "pending",
          lastError: null,
          nextRunAt: getNextWindowStart(new Date(), config.postingWindowStart, config.postingWindowEnd)
        });
        continue;
      }

      const result = await queueAutoPostsForConfig(config, {
        source: "schedule",
        immediate: false
      });
      processed += result.queued;
    } catch (error) {
      await updateAutoPostState(config._id, {
        lastRunAt: new Date(),
        nextRunAt: getNextAutoRun(config.intervalMinutes, config.postingWindowStart, config.postingWindowEnd),
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastStatus: "failed",
        lastError: error instanceof Error ? error.message : "Auto Post failed"
      });

      await logAndNotifyError({
        userId: config.userId,
        message: error instanceof Error ? error.message : "Unable to process Auto Post",
        metadata: { autoPostAi: true, autoPostAiConfigId: config._id, source: "schedule" },
        error
      });
    }
  }

  return processed;
}



