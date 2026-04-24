import { randomUUID } from "crypto";
import sharp from "sharp";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
import { CommentInbox } from "@/models/CommentInbox";
import { Job } from "@/models/Job";
import { MediaCache } from "@/models/MediaCache";
import { Post } from "@/models/Post";
import { Schedule } from "@/models/Schedule";
import { finalizeTrackedPostIfComplete, notifyCommentFailure } from "@/lib/services/comment-automation";
import { logCommentStage } from "@/lib/services/comment-logging";
import { updateAutoPostRecords } from "@/lib/services/automation-records";
import { updateAutoPostAiRecords } from "@/lib/services/automation-records-ai";
import { FacebookPublishError, fetchFacebookPageProfileImage, publishPostToFacebook, replyToFacebookComment } from "@/lib/services/facebook";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection, getStoredFacebookConnection } from "@/lib/services/integration-auth";
import { fetchDriveImageBinary } from "@/lib/services/google-drive";
import { recordMetricSnapshot } from "@/lib/services/analytics";
import { isDuplicatePostBlocked } from "@/lib/services/duplicate";
import { contentFingerprint } from "@/lib/services/fingerprint";
import { logAction, logAndNotifyError, serializeError } from "@/lib/services/logging";
import { checkRateLimits } from "@/lib/services/rate-limit";
import { getUserSettings, randomDelayMs } from "@/lib/services/settings";
import { computeNextRunAt, randomItem } from "@/lib/utils";

const AUTO_POST_PAGE_SPACING_MINUTES = Number(process.env.AUTO_POST_PAGE_SPACING_MINUTES ?? "10");
const FACEBOOK_RATE_LIMIT_COOLDOWN_MINUTES = Number(process.env.FACEBOOK_RATE_LIMIT_COOLDOWN_MINUTES ?? "60");
const COMMENT_REPLY_RATE_LIMIT_COOLDOWN_MINUTES = Number(process.env.COMMENT_REPLY_RATE_LIMIT_COOLDOWN_MINUTES ?? "30");
const COMMENT_REPLY_IMMEDIATE_BATCH_SIZE = Number(process.env.COMMENT_REPLY_IMMEDIATE_BATCH_SIZE ?? "5");
const USER_JOB_LOCK_WINDOW_MS = Number(process.env.USER_JOB_LOCK_WINDOW_MS ?? String(5 * 60 * 1000));

type ResolvedImage =
  | { kind: "url"; value: string }
  | { kind: "binary"; fileName: string; bytes: ArrayBuffer; mimeType: string };

type LeanMediaCache = {
  bytesBase64?: string;
  fileName: string;
  mimeType: string;
};

type LeanDriveConnection = {
  accessToken: string;
};

type LeanFacebookConnection = {
  pages: Array<{
    pageId: string;
    pageAccessToken: string;
  }>;
};

type LeanPost = {
  _id: string;
  userId: string;
  content: string;
  pinnedComment?: string;
  externalPostId?: string;
  autoCommentEnabled?: boolean;
  autoCommentMode?: "standard" | "multi-image-ai";
  autoCommentOptionReplies?: Array<{
    optionKey: string;
    replyText: string;
  }>;
  hashtags: string[];
  imageUrls: string[];
  targetPageIds: string[];
  randomizeImages: boolean;
  randomizeCaption: boolean;
  postingMode: "broadcast" | "random-page";
  variants?: Array<{
    caption: string;
    hashtags: string[];
  }>;
  fingerprint?: string;
};

type LeanSchedule = {
  _id: string;
  userId: string;
  postId: string;
  frequency: "once" | "hourly" | "daily" | "weekly";
  intervalHours?: number;
  runAt: Date;
  nextRunAt: Date;
  enabled: boolean;
  timezone?: string;
};

type JobExecution = {
  _id: string;
  userId: string;
  type?: "post" | "comment-reply";
  postId?: string;
  scheduleId?: string;
  targetPageId: string;
  attempts: number;
  maxAttempts: number;
  fingerprint?: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
};

type JobType = "post" | "comment-reply";

type LeanCommentInbox = {
  _id: string;
  pageId: string;
  postId?: string;
  externalCommentId?: string;
  replyText?: string;
  replyExternalId?: string | null;
  correlationId?: string;
};

type EnqueueOptions = {
  scheduleId?: string;
  applyRandomDelay?: boolean;
  startAt?: Date;
  payloadExtras?: Record<string, unknown>;
};

const MODERN_DIGIT_PATHS: Record<string, string> = {
  "0": "M50 20 C68 20 80 34 80 70 C80 106 68 120 50 120 C32 120 20 106 20 70 C20 34 32 20 50 20 Z",
  "1": "M38 40 L58 28 L58 120",
  "2": "M24 44 C28 28 40 20 56 20 C72 20 82 30 82 44 C82 56 76 64 62 74 L38 92 C30 98 26 104 24 112 L84 112",
  "3": "M28 34 C36 24 46 20 58 20 C72 20 82 28 82 42 C82 54 74 62 62 66 C76 70 84 80 84 94 C84 110 70 120 52 120 C38 120 28 116 20 108",
  "4": "M72 120 L72 20 L24 82 L88 82",
  "5": "M80 20 L32 20 L28 64 C36 56 44 52 56 52 C74 52 86 64 86 86 C86 108 72 120 50 120 C34 120 24 114 18 106",
  "6": "M76 26 C70 22 64 20 56 20 C34 20 20 40 20 72 C20 104 34 120 54 120 C72 120 84 108 84 90 C84 72 72 60 56 60 C42 60 32 66 26 78",
  "7": "M20 24 L84 24 L42 120",
  "8": "M52 20 C70 20 82 30 82 46 C82 58 74 68 62 72 C78 78 88 90 88 104 C88 120 72 132 52 132 C32 132 16 120 16 104 C16 90 26 78 42 72 C30 68 22 58 22 46 C22 30 34 20 52 20 Z",
  "9": "M78 62 C72 74 62 80 48 80 C32 80 20 68 20 50 C20 32 34 20 52 20 C72 20 86 36 86 68 C86 100 72 120 48 120 C38 120 30 118 22 112"
};

function createModernDigitSvg(digit: string, x: number, y: number, size: number, strokeWidth: number) {
  const path = MODERN_DIGIT_PATHS[digit] ?? MODERN_DIGIT_PATHS["0"];
  const scale = size / 140;
  return `<g transform="translate(${x}, ${y}) scale(${scale})">
    <path d="${path}" fill="none" stroke="#ffffff" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;
}

function buildSequenceBadgeSvg(sequence: number, badgeSize: number) {
  const digits = String(sequence).slice(0, 2).split("");
  const digitSize = digits.length === 1 ? badgeSize * 0.58 : badgeSize * 0.42;
  const gap = digits.length === 1 ? 0 : badgeSize * 0.04;
  const totalWidth = digits.length * digitSize + (digits.length - 1) * gap;
  const startX = (badgeSize - totalWidth) / 2;
  const startY = (badgeSize - digitSize) / 2;
  const strokeWidth = digits.length === 1 ? 12 : 10;
  const digitsSvg = digits
    .map((digit, index) =>
      createModernDigitSvg(digit, startX + index * (digitSize + gap), startY, digitSize, strokeWidth)
    )
    .join("");

  return `
    <svg width="${badgeSize}" height="${badgeSize}" viewBox="0 0 ${badgeSize} ${badgeSize}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="badgeFill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#2556d8"/>
          <stop offset="100%" stop-color="#123a9e"/>
        </linearGradient>
        <filter id="badgeShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#0f2d75" flood-opacity="0.32"/>
        </filter>
      </defs>
      <circle cx="${badgeSize / 2}" cy="${badgeSize / 2}" r="${badgeSize / 2 - 5}" fill="url(#badgeFill)" stroke="rgba(255,255,255,0.96)" stroke-width="4" filter="url(#badgeShadow)"/>
      <circle cx="${badgeSize / 2}" cy="${badgeSize / 2}" r="${badgeSize / 2 - 10}" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>
      ${digitsSvg}
    </svg>
  `;
}

async function addSequenceBadgeToImage(image: ResolvedImage, sequence: number): Promise<ResolvedImage> {
  if (image.kind !== "binary") {
    return image;
  }

  const inputBuffer = Buffer.from(image.bytes);
  const metadata = await sharp(inputBuffer).metadata();
  const badgeSize = Math.max(72, Math.round(Math.min(metadata.width ?? 1200, metadata.height ?? 1200) * 0.13));
  const badgeSvg = Buffer.from(buildSequenceBadgeSvg(sequence, badgeSize));

  const output = await sharp(inputBuffer)
    .composite([{ input: badgeSvg, top: 20, left: 20 }])
    .toBuffer({ resolveWithObject: true });

  return {
    kind: "binary",
    fileName: image.fileName,
    bytes: Uint8Array.from(output.data).buffer,
    mimeType: output.info.format === "png" ? "image/png" : "image/jpeg"
  };
}

async function addPageProfileBadgeToImage(image: ResolvedImage, profileImage?: { bytes: ArrayBuffer; mimeType: string } | null): Promise<ResolvedImage> {
  if (image.kind !== "binary" || !profileImage) {
    return image;
  }

  const inputBuffer = Buffer.from(image.bytes);
  const metadata = await sharp(inputBuffer).metadata();
  const baseSize = Math.min(metadata.width ?? 1200, metadata.height ?? 1200);
  const avatarSize = Math.max(92, Math.round(baseSize * 0.17));
  const containerWidth = Math.round(avatarSize * 1.18);
  const containerHeight = Math.round(avatarSize * 1.18);
  const inset = Math.max(32, Math.round(baseSize * 0.055));
  const avatarInset = Math.round((containerWidth - avatarSize) / 2);
  const profileBuffer = await sharp(Buffer.from(profileImage.bytes))
    .resize(avatarSize, avatarSize, { fit: "cover" })
    .png()
    .toBuffer();

  const containerSvg = Buffer.from(`
    <svg width="${containerWidth}" height="${containerHeight}" viewBox="0 0 ${containerWidth} ${containerHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="profileFrame" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.96)"/>
          <stop offset="100%" stop-color="rgba(233,241,255,0.9)"/>
        </linearGradient>
        <filter id="profileShadow" x="-35%" y="-35%" width="180%" height="180%">
          <feDropShadow dx="0" dy="9" stdDeviation="9" flood-color="#0f172a" flood-opacity="0.26"/>
        </filter>
      </defs>
      <rect x="3" y="3" width="${containerWidth - 6}" height="${containerHeight - 6}" rx="${Math.round(containerWidth * 0.34)}" fill="url(#profileFrame)" fill-opacity="0.96" stroke="rgba(255,255,255,0.9)" stroke-width="2" filter="url(#profileShadow)"/>
      <circle cx="${containerWidth / 2}" cy="${containerHeight / 2}" r="${avatarSize / 2 + 5}" fill="none" stroke="rgba(37,86,216,0.9)" stroke-width="3"/>
      <circle cx="${containerWidth / 2}" cy="${containerHeight / 2}" r="${avatarSize / 2 + 1}" fill="none" stroke="rgba(255,255,255,0.82)" stroke-width="2"/>
    </svg>
  `);

  const maskSvg = Buffer.from(
    `<svg width="${avatarSize}" height="${avatarSize}" viewBox="0 0 ${avatarSize} ${avatarSize}" xmlns="http://www.w3.org/2000/svg"><circle cx="${avatarSize / 2}" cy="${
      avatarSize / 2
    }" r="${avatarSize / 2 - 4}" fill="#ffffff"/></svg>`
  );

  const avatar = await sharp(profileBuffer)
    .composite([{ input: maskSvg, blend: "dest-in" }])
    .png()
    .toBuffer();

  const top = Math.max(24, (metadata.height ?? baseSize) - containerHeight - inset);
  const left = Math.max(24, (metadata.width ?? baseSize) - containerWidth - inset);

  const output = await sharp(inputBuffer)
    .composite([
      {
        input: avatar,
        top: top + avatarInset,
        left: left + avatarInset
      },
      {
        input: containerSvg,
        top,
        left
      }
    ])
    .toBuffer({ resolveWithObject: true });

  return {
    kind: "binary",
    fileName: image.fileName,
    bytes: Uint8Array.from(output.data).buffer,
    mimeType: output.info.format === "png" ? "image/png" : "image/jpeg"
  };
}

async function decorateAutoPostImages(
  images: ResolvedImage[],
  automationMode?: unknown,
  profileImage?: { bytes: ArrayBuffer; mimeType: string } | null
) {
  if (images.length === 0) {
    return images;
  }

  const decorated: ResolvedImage[] = [];
  for (const [index, image] of images.entries()) {
    const withSequence =
      automationMode === "multi-image-ai" && images.length > 1 ? await addSequenceBadgeToImage(image, index + 1) : image;
    decorated.push(await addPageProfileBadgeToImage(withSequence, profileImage));
  }
  return decorated;
}

function getBoundAutoPostConfigIds(job: JobExecution) {
  return {
    autoPostConfigId: typeof job.payload?.autoPostConfigId === "string" ? String(job.payload.autoPostConfigId) : null,
    autoPostAiConfigId: typeof job.payload?.autoPostAiConfigId === "string" ? String(job.payload.autoPostAiConfigId) : null
  };
}

function hasBoundAutoPostConfig(job: JobExecution) {
  const ids = getBoundAutoPostConfigIds(job);
  return Boolean(ids.autoPostConfigId || ids.autoPostAiConfigId);
}

function getAutoPostLogFlags(job: JobExecution) {
  const { autoPostConfigId, autoPostAiConfigId } = getBoundAutoPostConfigIds(job);
  if (autoPostAiConfigId) {
    return { autoPostAi: true };
  }
  if (autoPostConfigId) {
    return { autoPost: true };
  }
  return {};
}

async function updateBoundAutoPostState(
  job: JobExecution,
  configUpdates: Record<string, unknown>,
  recordUpdates: {
    autoPostStatus?: "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
    currentJobStatus?: "pending" | "processing" | "posted" | "failed";
    lastError?: string | null;
    message?: string;
    pageId?: string;
    imageUsed?: string;
    nextRunAt?: string;
    lastRunAt?: string;
  }
) {
  const { autoPostConfigId, autoPostAiConfigId } = getBoundAutoPostConfigIds(job);

  if (autoPostConfigId) {
    await AutoPostConfig.findByIdAndUpdate(autoPostConfigId, configUpdates);
    await updateAutoPostRecords({ configId: autoPostConfigId, ...recordUpdates });
  }

  if (autoPostAiConfigId) {
    await AutoPostAiConfig.findByIdAndUpdate(autoPostAiConfigId, configUpdates);
    await updateAutoPostAiRecords({ configId: autoPostAiConfigId, ...recordUpdates });
  }
}

function normalizeHashtags(hashtags?: string[]) {
  return (hashtags ?? [])
    .map((hashtag) => hashtag.trim())
    .filter(Boolean)
    .map((hashtag) => (hashtag.startsWith("#") ? hashtag : `#${hashtag}`));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPublishMessage(caption: string, hashtags?: string[]) {
  const normalizedHashtags = normalizeHashtags(hashtags);
  const hashtagBlock = normalizedHashtags.join(" ").trim();
  let cleanedCaption = caption.trim();

  if (hashtagBlock) {
    const hashtagPattern = escapeRegExp(hashtagBlock).replace(/\s+/g, "\\s+");
    const trailingHashtagBlock = new RegExp(`(?:\\n\\s*)*${hashtagPattern}\\s*$`, "i");

    while (trailingHashtagBlock.test(cleanedCaption)) {
      cleanedCaption = cleanedCaption.replace(trailingHashtagBlock, "").trimEnd();
    }
  }

  if (!hashtagBlock) {
    return cleanedCaption;
  }

  return cleanedCaption ? `${cleanedCaption}\n\n${hashtagBlock}` : hashtagBlock;
}

async function resolveImages(userId: string, imageRefs: string[]): Promise<ResolvedImage[]> {
  if (imageRefs.length === 0) {
    return [];
  }

  const driveConnection = imageRefs.some((ref) => ref.startsWith("drive:"))
    ? ((await ensureValidGoogleDriveConnection(userId)) as LeanDriveConnection | null)
    : null;
  const images: ResolvedImage[] = [];

  for (const ref of imageRefs) {
    if (ref.startsWith("drive:") || ref.startsWith("upload:")) {
      const isDriveRef = ref.startsWith("drive:");
      if (isDriveRef && !driveConnection) {
        throw new Error("Google Drive is not connected");
      }

      const fileId = ref.replace(isDriveRef ? "drive:" : "upload:", "");
      const cached = (await MediaCache.findOne({
        userId,
        fileId,
        expiresAt: { $gte: new Date() }
      }).lean()) as LeanMediaCache | null;

      if (cached?.bytesBase64) {
        images.push({
          kind: "binary",
          fileName: cached.fileName,
          bytes: Uint8Array.from(Buffer.from(cached.bytesBase64, "base64")).buffer,
          mimeType: cached.mimeType
        });
        continue;
      }

      if (!isDriveRef) {
        throw new Error("Uploaded image is no longer available. Please upload it again.");
      }

      const activeDriveConnection = driveConnection;
      if (!activeDriveConnection) {
        throw new Error("Google Drive is not connected");
      }

      const file = await fetchDriveImageBinary(activeDriveConnection.accessToken, fileId);
      await MediaCache.findOneAndUpdate(
        { userId, fileId },
        {
          userId,
          fileId,
          mimeType: file.mimeType,
          fileName: `${fileId}.jpg`,
          bytesBase64: Buffer.from(file.bytes).toString("base64"),
          source: "google-drive",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        },
        { upsert: true, new: true }
      );

      images.push({
        kind: "binary",
        fileName: `${fileId}.jpg`,
        bytes: file.bytes,
        mimeType: file.mimeType
      });
      continue;
    }

    images.push({ kind: "url", value: ref });
  }

  return images;
}

function getRetryDelayMs(attempts: number) {
  const steps = [2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  return steps[Math.min(attempts, steps.length - 1)];
}

function classifyPublishFailure(error: unknown) {
  if (error instanceof FacebookPublishError) {
    return {
      errorCode: error.code,
      failureReason: error.message,
      errorDetails: error.details ?? null,
      retryable: error.retryable
    };
  }

  const message = error instanceof Error ? error.message : "Unknown publishing error";
  const normalized = message.toLowerCase();

  if (normalized.includes("token expired") || normalized.includes("reconnect")) {
    return {
      errorCode: "token_expired",
      failureReason: message,
      errorDetails: null,
      retryable: false
    };
  }

  if (normalized.includes("permission") || normalized.includes("not authorized")) {
    return {
      errorCode: "permission_denied",
      failureReason: message,
      errorDetails: null,
      retryable: false
    };
  }

  if (normalized.includes("media") || normalized.includes("image") || normalized.includes("photo")) {
    return {
      errorCode: "media_invalid",
      failureReason: message,
      errorDetails: null,
      retryable: false
    };
  }

  if (normalized.includes("rate limited")) {
    return {
      errorCode: "rate_limited",
      failureReason: message,
      errorDetails: null,
      retryable: true
    };
  }

  return {
    errorCode: "unknown_publish_error",
    failureReason: message,
    errorDetails: error instanceof Error ? serializeError(error) : { reason: message },
    retryable: true
  };
}

async function acquireNextRunnableJob(jobType?: JobType): Promise<Record<string, unknown> | null> {
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + USER_JOB_LOCK_WINDOW_MS);
  const correlationId = randomUUID();
  const busyUserIds = (await Job.distinct("userId", {
    status: "processing",
    lockExpiresAt: { $gt: now }
  })) as unknown[];

  const userScope =
    busyUserIds.length > 0
      ? { userId: { $nin: busyUserIds } }
      : {};

  const job = await Job.findOneAndUpdate(
    {
      ...(jobType ? { type: jobType } : {}),
      status: { $in: ["queued", "retrying", "rate_limited"] },
      nextRunAt: { $lte: now },
      ...userScope,
      $or: [{ lockExpiresAt: { $exists: false } }, { lockExpiresAt: null }, { lockExpiresAt: { $lte: now } }]
    },
    {
      $set: {
        status: "processing",
        processingStartedAt: now,
        lockedAt: now,
        lockExpiresAt,
        correlationId,
        lastAttemptAt: now
      }
    },
    { sort: { nextRunAt: 1 }, new: true }
  ).lean();

  return (job as Record<string, unknown> | null) ?? null;
}

async function applyUserPublishCooldown(userId: string, nextRetryAt: Date, reason: string, sourceJobId: string) {
  await Job.updateMany(
    {
      userId,
      type: "post",
      _id: { $ne: sourceJobId },
      status: { $in: ["queued", "retrying", "rate_limited"] }
    },
    {
      $set: {
        status: "rate_limited",
        nextRunAt: nextRetryAt,
        nextRetryAt,
        lastError: reason,
        failureReason: reason,
        errorCode: "rate_limited_cooldown"
      }
    }
  );
}

async function applyUserJobCooldown(userId: string, jobType: JobType, nextRetryAt: Date, reason: string, sourceJobId: string, targetPageId?: string) {
  await Job.updateMany(
    {
      userId,
      type: jobType,
      _id: { $ne: sourceJobId },
      ...(targetPageId ? { targetPageId } : {}),
      status: { $in: ["queued", "retrying", "rate_limited"] }
    },
    {
      $set: {
        status: "rate_limited",
        nextRunAt: nextRetryAt,
        nextRetryAt,
        lastError: reason,
        failureReason: reason,
        errorCode: "rate_limited_cooldown"
      }
    }
  );
}

export async function enqueuePostJobsForPost(userId: string, postId: string, options: EnqueueOptions = {}) {
  const post = (await Post.findById(postId).lean()) as LeanPost | null;
  if (!post) {
    throw new Error("Post not found");
  }

  const connection = (await ensureValidFacebookConnection(userId)) as LeanFacebookConnection;
  if (!connection || connection.pages.length === 0) {
    throw new Error("No Facebook pages connected");
  }

  const availablePages = connection.pages.filter((page) => post.targetPageIds.includes(page.pageId));
  if (availablePages.length === 0) {
    throw new Error("No matching target pages were found");
  }

  const selectedPages = post.postingMode === "random-page" ? [randomItem(availablePages)] : availablePages;
  const { settings } = await getUserSettings(userId);
  const safeSettings = {
    minDelaySeconds: settings?.minDelaySeconds ?? 15,
    maxDelaySeconds: settings?.maxDelaySeconds ?? 90
  };

  let queued = 0;
  for (const [pageIndex, page] of selectedPages.entries()) {
    const fingerprint = post.fingerprint ?? contentFingerprint({
      content: post.content,
      hashtags: post.hashtags,
      imageUrls: post.imageUrls,
      targetPageIds: [page.pageId]
    });

    const spacingMinutes = options.payloadExtras?.autoPostConfigId || options.payloadExtras?.autoPostAiConfigId
      ? AUTO_POST_PAGE_SPACING_MINUTES
      : 0;
    const nextRunAt = options.startAt
      ? new Date(options.startAt.getTime() + pageIndex * spacingMinutes * 60 * 1000)
      : options.applyRandomDelay === false
        ? new Date()
        : new Date(Date.now() + randomDelayMs(safeSettings.minDelaySeconds, safeSettings.maxDelaySeconds));

    await Job.create({
      userId,
      type: "post",
      scheduleId: options.scheduleId,
      postId: post._id,
      targetPageId: page.pageId,
      fingerprint,
      payload: {
        postingMode: post.postingMode,
        randomizeImages: post.randomizeImages,
        randomizeCaption: post.randomizeCaption,
        ...(options.payloadExtras ?? {})
      },
      nextRunAt,
      maxAttempts: 3,
      status: "queued"
    });

    queued += 1;
  }

  return queued;
}

export async function enqueueJobsForDueSchedules() {
  const schedules = (await Schedule.find({ enabled: true, nextRunAt: { $lte: new Date() } }).sort({ nextRunAt: 1 }).lean()) as unknown as LeanSchedule[];
  let queued = 0;

  for (const schedule of schedules) {
    try {
      const jobsCreated = await enqueuePostJobsForPost(String(schedule.userId), String(schedule.postId), {
        scheduleId: String(schedule._id)
      });
      queued += jobsCreated;

      await logAction({
        userId: String(schedule.userId),
        type: "queue",
        level: "info",
        message: `Queued ${jobsCreated} job(s) from schedule`,
        relatedPostId: String(schedule.postId),
        relatedScheduleId: String(schedule._id),
        metadata: { frequency: schedule.frequency, intervalHours: schedule.intervalHours ?? 1 }
      });

      if (schedule.frequency === "once") {
        await Schedule.findByIdAndUpdate(schedule._id, { enabled: false, lastRunAt: new Date() });
      } else {
        await Schedule.findByIdAndUpdate(schedule._id, {
          lastRunAt: new Date(),
          nextRunAt: computeNextRunAt(
            schedule.frequency,
            schedule.runAt.toISOString(),
            new Date(),
            schedule.intervalHours ?? 1,
            schedule.timezone ?? "Asia/Bangkok"
          )
        });
      }
    } catch (error) {
      await logAndNotifyError({
        userId: String(schedule.userId),
        message: error instanceof Error ? error.message : "Unable to enqueue scheduled jobs",
        relatedPostId: String(schedule.postId),
        relatedScheduleId: String(schedule._id),
        error
      });
    }
  }

  return queued;
}

async function executePostJob(job: JobExecution) {
  if (!job.postId) {
    throw new Error("Missing post ID for post job");
  }

  const { settings } = await getUserSettings(job.userId);
  const safeSettings = {
    duplicateWindowHours: settings?.duplicateWindowHours ?? 24,
    autoPostDuplicateWindowHours: settings?.autoPostDuplicateWindowHours ?? 0
  };

  const rateLimit = await checkRateLimits(job.userId, "post");
  if (!rateLimit.allowed) {
    const nextRetryAt = new Date(Date.now() + FACEBOOK_RATE_LIMIT_COOLDOWN_MINUTES * 60 * 1000);
    await Job.findByIdAndUpdate(job._id, {
      status: "rate_limited",
      nextRunAt: nextRetryAt,
      nextRetryAt,
      lastError: rateLimit.reason,
      failureReason: rateLimit.reason,
      errorCode: "rate_limited",
      errorDetails: { reason: rateLimit.reason },
      lockExpiresAt: null
    });

    await logAction({
      userId: job.userId,
      type: "queue",
      level: "warn",
      message: `[PUBLISHER] post ${job.postId} rate limited`,
      relatedJobId: job._id,
      relatedPostId: job.postId,
      relatedScheduleId: job.scheduleId,
      metadata: {
        ...getAutoPostLogFlags(job),
        targetPageId: job.targetPageId,
        autoPostConfigId: job.payload?.autoPostConfigId,
        autoPostAiConfigId: job.payload?.autoPostAiConfigId,
        correlationId: job.correlationId,
        nextRetryAt: nextRetryAt.toISOString(),
        reason: rateLimit.reason
      }
    });

    await applyUserPublishCooldown(job.userId, nextRetryAt, rateLimit.reason ?? "Rate limited", job._id);

    if (hasBoundAutoPostConfig(job)) {
      await updateBoundAutoPostState(
        job,
        {
          autoPostStatus: "retrying",
          jobStatus: "pending",
          lastStatus: "failed",
          retryCount: (job.attempts ?? 0) + 1,
          lastError: rateLimit.reason ?? "Rate limited",
          nextRunAt: nextRetryAt
        },
        {
          autoPostStatus: "retrying",
          currentJobStatus: "pending",
          lastError: rateLimit.reason ?? "Rate limited",
          message: rateLimit.reason ?? "Rate limited",
          pageId: job.targetPageId,
          imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
        }
      );
    }

    return { status: "rate_limited" };
  }

  if (job.fingerprint) {
    const duplicateWindowHours = hasBoundAutoPostConfig(job)
      ? safeSettings.autoPostDuplicateWindowHours
      : safeSettings.duplicateWindowHours;
    const blocked = await isDuplicatePostBlocked({
      userId: job.userId,
      fingerprint: job.fingerprint,
      duplicateWindowHours
    });

    if (blocked) {
      await Job.findByIdAndUpdate(job._id, {
        status: "duplicate_blocked",
        completedAt: new Date(),
        lastError: "Duplicate content blocked by protection window",
        failureReason: "Duplicate content blocked by protection window",
        errorCode: "duplicate_blocked",
        errorDetails: { fingerprint: job.fingerprint },
        lockExpiresAt: null
      });
      await logAction({
        userId: job.userId,
        type: "post",
        level: "warn",
        message: "Duplicate post blocked before publishing",
        relatedJobId: job._id,
        relatedPostId: job.postId,
        relatedScheduleId: job.scheduleId,
        metadata: {
          ...getAutoPostLogFlags(job),
          targetPageId: job.targetPageId,
          autoPostConfigId: job.payload?.autoPostConfigId,
          autoPostAiConfigId: job.payload?.autoPostAiConfigId
        }
      });
      if (hasBoundAutoPostConfig(job)) {
        await updateBoundAutoPostState(
          job,
          {
            autoPostStatus: "failed",
            jobStatus: "failed",
            lastStatus: "failed",
            retryCount: job.attempts ?? 0,
            lastError: "Duplicate auto post was blocked by duplicate protection"
          },
          {
            autoPostStatus: "failed",
            currentJobStatus: "failed",
            lastError: "Duplicate auto post was blocked by duplicate protection",
            message: "Duplicate auto post was blocked by duplicate protection",
            pageId: job.targetPageId,
            imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
          }
        );
      }
      return { status: "duplicate_blocked" };
    }
  }

  const post = (await Post.findById(job.postId).lean()) as LeanPost | null;
  const connection = (await ensureValidFacebookConnection(job.userId)) as LeanFacebookConnection;
  if (!post || !connection) {
    throw new Error("Missing post or Facebook connection");
  }

  const page = connection.pages.find((item) => item.pageId === job.targetPageId);
  if (!page) {
    throw new Error("Target page token was not found");
  }

  let pageProfileImage: { bytes: ArrayBuffer; mimeType: string } | null = null;
  if (hasBoundAutoPostConfig(job)) {
    try {
      pageProfileImage = await fetchFacebookPageProfileImage({
        pageId: page.pageId,
        pageAccessToken: page.pageAccessToken
      });
    } catch (error) {
      pageProfileImage = null;
      await logAction({
        userId: job.userId,
        type: "queue",
        level: "warn",
        message: "Could not fetch Facebook page profile image for image watermark",
        relatedJobId: job._id,
        relatedPostId: job.postId,
        relatedScheduleId: job.scheduleId,
        metadata: {
          ...getAutoPostLogFlags(job),
          targetPageId: page.pageId,
          correlationId: job.correlationId,
          error: error instanceof Error ? error.message : "unknown"
        }
      });
    }
  }

  const variants = post.variants?.length ? post.variants : [{ caption: post.content, hashtags: post.hashtags }];
  const chosenVariant = post.randomizeCaption ? randomItem(variants) : variants[0];
  const message = buildPublishMessage(chosenVariant.caption, chosenVariant.hashtags);
  const imageRefs = post.randomizeImages && post.imageUrls.length > 0 ? [randomItem(post.imageUrls)] : post.imageUrls;
  const images = await decorateAutoPostImages(
    await resolveImages(job.userId, imageRefs),
    job.payload?.automationMode,
    pageProfileImage
  );

  if (hasBoundAutoPostConfig(job)) {
    await updateBoundAutoPostState(
      job,
      {
        autoPostStatus: "posting",
        jobStatus: "processing",
        lastStatus: "pending",
        lastError: null
      },
      {
        autoPostStatus: "posting",
        currentJobStatus: "processing",
        lastError: null,
        message: "Publishing to Facebook page",
        pageId: job.targetPageId,
        imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
      }
    );
  }

  const publishResult = await publishPostToFacebook({
    pageId: page.pageId,
    pageAccessToken: page.pageAccessToken,
    message,
    images
  });

  await Job.findByIdAndUpdate(job._id, {
    status: "success",
    completedAt: new Date(),
    attempts: job.attempts + 1,
    result: publishResult,
    lastError: null,
    failureReason: null,
    errorCode: null,
    errorDetails: null,
    nextRetryAt: null,
    lockExpiresAt: null
  });

  await Post.findByIdAndUpdate(post._id, {
    status: "published",
    externalPostId: typeof publishResult?.id === "string" ? publishResult.id : undefined,
    lastPublishedAt: new Date(),
    $inc: { successCount: 1 }
  });

  await recordMetricSnapshot({
    userId: job.userId,
    postId: String(post._id),
    scheduleId: job.scheduleId,
    pageId: page.pageId,
    externalPostId: typeof publishResult?.id === "string" ? publishResult.id : undefined,
    source: "estimated"
  });

  await logAction({
    userId: job.userId,
    type: "post",
    level: "success",
    message: `[PUBLISHER] post ${post._id} success`,
    relatedJobId: job._id,
    relatedPostId: String(post._id),
    relatedScheduleId: job.scheduleId,
    metadata: {
      ...getAutoPostLogFlags(job),
      targetPageId: page.pageId,
      publishResult,
      autoPostConfigId: job.payload?.autoPostConfigId,
      autoPostAiConfigId: job.payload?.autoPostAiConfigId,
      correlationId: job.correlationId
    }
  });

  if (hasBoundAutoPostConfig(job)) {
    await updateBoundAutoPostState(
      job,
      {
        autoPostStatus: "waiting",
        jobStatus: "posted",
        lastStatus: "posted",
        retryCount: 0,
        lastError: null,
        lastPostId: post._id,
        lastRunAt: new Date()
      },
      {
        autoPostStatus: "waiting",
        currentJobStatus: "posted",
        lastError: null,
        message: "Post published successfully",
        pageId: page.pageId,
        imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined,
        lastRunAt: new Date().toISOString()
      }
    );
  }

  return { status: "success" };
}

async function executeCommentReplyJob(job: JobExecution) {
  const rateLimit = await checkRateLimits(job.userId, "comment-reply");
  if (!rateLimit.allowed) {
    const nextRetryAt = new Date(Date.now() + COMMENT_REPLY_RATE_LIMIT_COOLDOWN_MINUTES * 60 * 1000);
    await Job.findByIdAndUpdate(job._id, {
      status: "rate_limited",
      nextRunAt: nextRetryAt,
      nextRetryAt,
      lastError: rateLimit.reason,
      failureReason: rateLimit.reason,
      errorCode: "rate_limited",
      errorDetails: { reason: rateLimit.reason },
      lockExpiresAt: null
    });

    await applyUserJobCooldown(
      job.userId,
      "comment-reply",
      nextRetryAt,
      rateLimit.reason ?? "Comment reply rate limited",
      job._id,
      job.targetPageId
    );

    await logAction({
      userId: job.userId,
      type: "comment",
      level: "warn",
      message: `[COMMENT] reply ${job._id} rate limited`,
      relatedJobId: job._id,
      metadata: {
        targetPageId: job.targetPageId,
        correlationId: job.correlationId,
        nextRetryAt: nextRetryAt.toISOString(),
        reason: rateLimit.reason
      }
    });

    return { status: "rate_limited" };
  }

  const commentInboxId = typeof job.payload?.commentInboxId === "string" ? job.payload.commentInboxId : "";
  const comment = (await CommentInbox.findById(commentInboxId).lean()) as LeanCommentInbox | null;
  const connection = (await getStoredFacebookConnection(job.userId)) as LeanFacebookConnection;

  if (!comment || !connection) {
    throw new Error("Missing comment inbox entry or Facebook connection");
  }

  if (comment.replyExternalId) {
    await Job.findByIdAndUpdate(job._id, {
      status: "success",
      completedAt: new Date(),
      attempts: job.attempts + 1,
      result: { deduped: true, replyExternalId: comment.replyExternalId },
      lastError: null,
      failureReason: null,
      errorCode: null,
      errorDetails: null,
      nextRetryAt: null,
      lockExpiresAt: null
    });

    return { status: "success" };
  }

  if (!comment.externalCommentId || !comment.replyText?.trim()) {
    throw new Error("Comment reply is missing the Facebook comment ID or reply text");
  }

  const page = connection.pages.find((item) => item.pageId === comment.pageId);
  if (!page) {
    throw new Error("Target page token was not found");
  }

  await CommentInbox.findByIdAndUpdate(comment._id, {
    status: "processing",
    lastAttemptAt: new Date(),
    $inc: { replyAttempts: 1 },
    replyError: null
  });

  await logCommentStage({
    userId: job.userId,
    commentInboxId,
    externalCommentId: comment.externalCommentId,
    correlationId: comment.correlationId ?? job.correlationId,
    stage: "job_processing",
    message: "Comment reply job is processing",
    metadata: {
      pageId: comment.pageId,
      jobId: job._id
    }
  });

  const replyResult = await replyToFacebookComment({
    externalCommentId: comment.externalCommentId,
    pageAccessToken: page.pageAccessToken,
    message: comment.replyText
  });

  await Job.findByIdAndUpdate(job._id, {
    status: "success",
    completedAt: new Date(),
    attempts: job.attempts + 1,
    result: replyResult,
    lastError: null,
    failureReason: null,
    errorCode: null,
    errorDetails: null,
    nextRetryAt: null,
    lockExpiresAt: null
  });

  await CommentInbox.findByIdAndUpdate(comment._id, {
    status: "replied",
    repliedAt: new Date(),
    replyExternalId: typeof replyResult?.id === "string" ? replyResult.id : null,
    replyError: null
  });

  await logCommentStage({
    userId: job.userId,
    commentInboxId,
    externalCommentId: comment.externalCommentId,
    correlationId: comment.correlationId ?? job.correlationId,
    stage: "reply_sent",
    message: "Comment reply sent successfully",
    metadata: {
      pageId: comment.pageId,
      jobId: job._id,
      replyExternalId: typeof replyResult?.id === "string" ? replyResult.id : undefined
    }
  });

  await logAction({
    userId: job.userId,
    type: "comment",
    level: "success",
    message: `[COMMENT] reply ${comment._id} success`,
    relatedJobId: job._id,
    metadata: {
      pageId: comment.pageId,
      commentInboxId: String(comment._id),
      externalCommentId: comment.externalCommentId,
      correlationId: job.correlationId
    }
  });

  if (comment.postId) {
    await finalizeTrackedPostIfComplete(job.userId, comment.postId);
  }

  return { status: "success" };
}

export async function processQueuedJobs(limit = 10, jobType?: JobType) {
  const processed: Array<{ jobId: string; status: string }> = [];
  let processedCount = 0;

  while (processedCount < limit) {
    const item = await acquireNextRunnableJob(jobType);
    if (!item) {
      break;
    }

    const job: JobExecution = {
      _id: String(item._id),
      userId: String(item.userId),
      type: item.type === "comment-reply" ? "comment-reply" : "post",
      postId: item.postId ? String(item.postId) : undefined,
      scheduleId: item.scheduleId ? String(item.scheduleId) : undefined,
      targetPageId: String(item.targetPageId),
      attempts: typeof item.attempts === "number" ? item.attempts : 0,
      maxAttempts: typeof item.maxAttempts === "number" ? item.maxAttempts : 3,
      fingerprint: typeof item.fingerprint === "string" ? item.fingerprint : undefined,
      payload: (item.payload ?? {}) as Record<string, unknown>,
      correlationId: typeof item.correlationId === "string" ? item.correlationId : undefined
    };

    try {
      await logAction({
        userId: job.userId,
        type: job.type === "comment-reply" ? "comment" : "queue",
        level: "info",
        message: job.type === "comment-reply" ? `[COMMENT] reply job ${job._id} started` : `[PUBLISHER] post ${job.postId} started`,
        relatedJobId: job._id,
        relatedPostId: job.type === "comment-reply" ? undefined : job.postId,
        relatedScheduleId: job.scheduleId,
        metadata: {
          ...getAutoPostLogFlags(job),
          targetPageId: job.targetPageId,
          correlationId: job.correlationId,
          attempt: job.attempts + 1
        }
      });
      const result = job.type === "comment-reply" ? await executeCommentReplyJob(job) : await executePostJob(job);
      processed.push({ jobId: job._id, status: result.status });
    } catch (error) {
      const failure = classifyPublishFailure(error);
      const attempts = job.attempts + 1;
      const shouldRetry = failure.retryable && attempts < job.maxAttempts;
      const nextRetryAt =
        failure.errorCode === "rate_limited"
          ? new Date(Date.now() + FACEBOOK_RATE_LIMIT_COOLDOWN_MINUTES * 60 * 1000)
          : shouldRetry
            ? new Date(Date.now() + getRetryDelayMs(attempts - 1))
            : null;

      if (failure.errorCode === "rate_limited" && nextRetryAt) {
        await applyUserPublishCooldown(job.userId, nextRetryAt, failure.failureReason, job._id);
      }

      await Job.findByIdAndUpdate(job._id, {
        status: shouldRetry ? "retrying" : "failed",
        attempts,
        nextRunAt: nextRetryAt ?? new Date(),
        nextRetryAt,
        lastError: failure.failureReason,
        failureReason: failure.failureReason,
        errorCode: failure.errorCode,
        errorDetails: failure.errorDetails,
        completedAt: shouldRetry ? null : new Date(),
        lockExpiresAt: null
      });

      if (job.type !== "comment-reply") {
        await Post.findByIdAndUpdate(job.postId, {
          status: shouldRetry ? "retrying" : "failed",
          $inc: { failedCount: 1 }
        });
      }

      if (job.type === "comment-reply") {
        const commentInboxId = typeof job.payload?.commentInboxId === "string" ? job.payload.commentInboxId : "";
        await CommentInbox.findByIdAndUpdate(commentInboxId, {
          status: shouldRetry ? "queued" : "failed",
          replyError: failure.failureReason,
          lastAttemptAt: new Date()
        });

        await notifyCommentFailure({
          userId: job.userId,
          commentInboxId,
          pageId: job.targetPageId,
          externalCommentId: typeof job.payload?.externalCommentId === "string" ? job.payload.externalCommentId : undefined,
          correlationId: job.correlationId,
          message: shouldRetry
            ? `Comment reply failed and will retry (${attempts}/${job.maxAttempts}): ${failure.failureReason}`
            : `Comment reply failed after ${attempts} attempts: ${failure.failureReason}`,
          error
        });
      } else {
        await logAndNotifyError({
          userId: job.userId,
          message: shouldRetry
            ? `[PUBLISHER] post ${job.postId} failed and will retry (${attempts}/${job.maxAttempts}): ${failure.failureReason}`
            : `[PUBLISHER] post ${job.postId} failed after ${attempts} attempts: ${failure.failureReason}`,
          metadata: {
            ...getAutoPostLogFlags(job),
            targetPageId: job.targetPageId,
            attempts,
            maxAttempts: job.maxAttempts,
            autoPostConfigId: job.payload?.autoPostConfigId,
            autoPostAiConfigId: job.payload?.autoPostAiConfigId,
            correlationId: job.correlationId,
            errorCode: failure.errorCode,
            nextRetryAt: nextRetryAt?.toISOString()
          },
          relatedJobId: job._id,
          relatedPostId: job.postId,
          relatedScheduleId: job.scheduleId,
          error
        });
      }

        if (job.type !== "comment-reply" && hasBoundAutoPostConfig(job)) {
          await updateBoundAutoPostState(
            job,
            {
              autoPostStatus: shouldRetry ? "retrying" : "failed",
              jobStatus: "failed",
              lastStatus: shouldRetry ? "pending" : "failed",
              retryCount: attempts,
              lastError: failure.failureReason,
              nextRunAt: nextRetryAt ?? undefined
            },
            {
              autoPostStatus: shouldRetry ? "retrying" : "failed",
              currentJobStatus: shouldRetry ? "pending" : "failed",
              lastError: failure.failureReason,
              message: shouldRetry
                ? `Publish failed and will retry (${attempts}/${job.maxAttempts})`
                : `Publish failed after ${attempts} attempts`,
              pageId: job.targetPageId,
              imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
            }
          );
        }

      processed.push({ jobId: job._id, status: shouldRetry ? "retrying" : "failed" });
    }

    processedCount += 1;
  }

  return processed;
}

export async function processCommentReplyJobs(limit = 5) {
  const safeLimit = Math.max(1, Math.min(limit, COMMENT_REPLY_IMMEDIATE_BATCH_SIZE));
  return processQueuedJobs(safeLimit, "comment-reply");
}





