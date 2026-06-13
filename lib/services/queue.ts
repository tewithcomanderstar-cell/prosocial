import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";
import sharp from "sharp";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
import { AffiliatePerformance } from "@/models/AffiliatePerformance";
import { AiGeneratedImage } from "@/models/AiGeneratedImage";
import { AiGeneratedPost } from "@/models/AiGeneratedPost";
import { CommentInbox } from "@/models/CommentInbox";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { Job } from "@/models/Job";
import { MediaCache } from "@/models/MediaCache";
import { Post } from "@/models/Post";
import { ProductPostHistory } from "@/models/ProductPostHistory";
import { Schedule } from "@/models/Schedule";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { finalizeTrackedPostIfComplete, notifyCommentFailure } from "@/lib/services/comment-automation";
import { logCommentStage } from "@/lib/services/comment-logging";
import { updateAutoPostRecords } from "@/lib/services/automation-records";
import { updateAutoPostAiRecords } from "@/lib/services/automation-records-ai";
import { commentOnFacebookPost, FacebookPublishError, publishPostToFacebook, replyToFacebookComment } from "@/lib/services/facebook";
import { composeImageWithLogo } from "@/lib/services/image-composer";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection, getStoredFacebookConnection } from "@/lib/services/integration-auth";
import { fetchDriveImageBinary } from "@/lib/services/google-drive";
import { recordMetricSnapshot } from "@/lib/services/analytics";
import { isDuplicatePostBlocked } from "@/lib/services/duplicate";
import { contentFingerprint } from "@/lib/services/fingerprint";
import { logAction, logAndNotifyError, serializeError } from "@/lib/services/logging";
import { getPageLogoForFacebookPage } from "@/lib/services/page-logo";
import { checkRateLimits } from "@/lib/services/rate-limit";
import { logExternalResponseFailure, traceExternalRequest } from "@/lib/services/request-debug";
import { getUserSettings, randomDelayMs } from "@/lib/services/settings";
import { countShopeeProductNameOccurrences } from "@/lib/services/shopee-affiliate-core";
import {
  getShopeeCanonicalProductKey,
  isShopeeShortLink,
  normalizeShopeeCaptionLinkLine,
  releaseShopeeProductReservation
} from "@/lib/services/shopee-affiliate";
import { normalizeTextEncoding, validateTextEncoding } from "@/lib/services/text-encoding";
import { computeNextRunAt, randomItem } from "@/lib/utils";

const AUTO_POST_PAGE_SPACING_MINUTES = Number(
  process.env.AUTO_POST_PAGE_INTERVAL_MINUTES ?? process.env.AUTO_POST_PAGE_SPACING_MINUTES ?? "10"
);
const FACEBOOK_RATE_LIMIT_COOLDOWN_MINUTES = Number(process.env.FACEBOOK_RATE_LIMIT_COOLDOWN_MINUTES ?? "60");
const COMMENT_REPLY_RATE_LIMIT_COOLDOWN_MINUTES = Number(process.env.COMMENT_REPLY_RATE_LIMIT_COOLDOWN_MINUTES ?? "30");
const COMMENT_REPLY_IMMEDIATE_BATCH_SIZE = Number(process.env.COMMENT_REPLY_IMMEDIATE_BATCH_SIZE ?? "5");
const USER_JOB_LOCK_WINDOW_MS = Number(process.env.USER_JOB_LOCK_WINDOW_MS ?? String(5 * 60 * 1000));
const QUEUE_SLOW_STAGE_WARNING_MS = 30_000;

function startQueueStageTimer(stage: string, metadata: Record<string, unknown> = {}) {
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  console.info("[STAGE_START]", {
    stage,
    startedAt: startedIso,
    ...metadata
  });

  return (status: "success" | "failed", extra: Record<string, unknown> = {}, error?: unknown) => {
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    const payload = {
      stage,
      status,
      startedAt: startedIso,
      completedAt: new Date(completedAt).toISOString(),
      STAGE_DURATION_MS: durationMs,
      durationMs,
      ...metadata,
      ...extra,
      ...(error
        ? {
            errorMessage: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack?.slice(0, 3000) : undefined
          }
        : {})
    };

    console.info("[STAGE_END]", payload);
    if (durationMs > QUEUE_SLOW_STAGE_WARNING_MS) {
      console.warn("[WARNING_STAGE_SLOW]", payload);
    }
  };
}

let notoSansThaiFont: { dataUri: string; format: "woff" | "woff2" } | null | undefined;

function readFontCandidate(fontPath: string) {
  if (!existsSync(fontPath)) return null;
  const fontBytes = readFileSync(fontPath);
  const format = fontPath.endsWith(".woff2") ? "woff2" : "woff";
  return {
    dataUri: `data:font/${format};base64,${fontBytes.toString("base64")}`,
    format
  } as const;
}

function getNotoSansThaiFont() {
  if (notoSansThaiFont !== undefined) return notoSansThaiFont;

  const fontCandidates = [
    path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-thai", "files", "noto-sans-thai-thai-700-normal.woff"),
    path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-thai", "files", "noto-sans-thai-thai-700-normal.woff2"),
    path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-thai", "files", "noto-sans-thai-thai-400-normal.woff"),
    path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-thai", "files", "noto-sans-thai-thai-400-normal.woff2")
  ];

  for (const candidate of fontCandidates) {
    try {
      const font = readFontCandidate(candidate);
      if (font) {
        notoSansThaiFont = font;
        return notoSansThaiFont;
      }
    } catch {
      // Font loading is a visual enhancement. It must never block publishing.
    }
  }

  console.warn("[shopee-render] Thai font file was not found; falling back to system fonts.");
  notoSansThaiFont = null;
  return notoSansThaiFont;
}

type ResolvedImage =
  | { kind: "url"; value: string }
  | { kind: "binary"; fileName: string; bytes: ArrayBuffer; mimeType: string };

type LeanMediaCache = {
  bytesBase64?: string;
  fileName: string;
  mimeType: string;
};

type LeanAiGeneratedImage = {
  _id: string;
  productId: string;
  generatedImageUrl?: string;
  fallbackImageUrl?: string;
  promptHistory?: string[];
  provider?: string;
};

type LeanShopeeProduct = {
  productId: string;
  productName: string;
  productDescription?: string;
  productPrice?: number;
  discountPrice?: number;
  discountPercent?: number;
  productImageUrl?: string;
  productImageUrls?: string[];
  category?: string;
  salesCount?: number;
  reviewCount?: number;
  rating?: number;
  shopName?: string;
};

type LeanDriveConnection = {
  accessToken: string;
};

type LeanFacebookConnection = {
  pages: Array<{
    pageId: string;
    name?: string;
    pageAccessToken: string;
    profilePictureUrl?: string | null;
    profilePictureFetchedAt?: Date | string | null;
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
  forceImmediate?: boolean;
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

async function addPageProfileBadgeToImage(
  image: ResolvedImage,
  profileImage?: { bytes: ArrayBuffer; mimeType: string } | null
): Promise<ResolvedImage> {
  return composeImageWithLogo(image, profileImage) as Promise<ResolvedImage>;
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

function isShopeeAffiliateJob(job: JobExecution) {
  const hasSingleProduct = typeof job.payload?.shopeeProductId === "string";
  const hasProductSet = Array.isArray(job.payload?.shopeeProductIds) && job.payload.shopeeProductIds.length > 0;
  return job.payload?.autoSource === "shopee-affiliate" && (hasSingleProduct || hasProductSet);
}

async function updateShopeeQueueStatus(
  job: JobExecution,
  status: "published" | "failed",
  details: {
    publishResult?: unknown;
    failureReason?: string;
    errorCode?: string;
  } = {}
) {
  if (!isShopeeAffiliateJob(job) || !job.postId) {
    return;
  }

  const productIds = Array.from(
    new Set(
      [
        ...(Array.isArray(job.payload?.shopeeProductIds) ? job.payload.shopeeProductIds : []),
        job.payload?.shopeeProductId
      ]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    )
  );

  if (productIds.length === 0) {
    return;
  }

  const update = {
    status,
    publishResult: details.publishResult ?? {},
    failureReason: details.failureReason ?? null,
    errorCode: details.errorCode ?? null
  };

  await FacebookPostQueue.updateMany(
    {
      userId: job.userId,
      pageId: job.targetPageId,
      productId: { $in: productIds },
      postId: job.postId
    },
    update
  );

  await ProductPostHistory.updateMany(
    {
      userId: job.userId,
      pageId: job.targetPageId,
      productId: { $in: productIds },
      postId: job.postId
    },
    {
      status,
      postedAt: new Date()
    }
  );

  const products = await ShopeeProduct.find({ productId: { $in: productIds } }).lean();
  const productById = new Map(products.map((product: any) => [String(product.productId), product]));
  if (status === "published") {
    for (const productId of productIds) {
      const product = productById.get(productId) ?? { productId };
      const canonicalProductKey = getShopeeCanonicalProductKey(product);
      await ProductPostHistory.findOneAndUpdate(
        {
          userId: job.userId,
          pageId: job.targetPageId,
          productId,
          postId: job.postId,
          status: "published"
        },
        {
          userId: job.userId,
          pageId: job.targetPageId,
          productId,
          shopId: String(product.shopId ?? ""),
          itemId: String(product.itemId ?? ""),
          productUrl: String(product.productUrl ?? ""),
          canonicalProductKey,
          productName: String(product.productName ?? ""),
          category: String(product.category ?? ""),
          productSource: String(product.sourceTag ?? "shopee-affiliate"),
          postId: job.postId,
          templatePostId: String(job.payload?.aiGeneratedPostId ?? ""),
          affiliateLink: String(job.payload?.affiliateLink ?? ""),
          shortLink: String(job.payload?.affiliateLink ?? ""),
          postedDate: new Date().toISOString().slice(0, 10),
          jobId: String(job.payload?.workflowRunId ?? job._id ?? ""),
          pageIds: [String(job.targetPageId ?? "")],
          postedAt: new Date(),
          status: "published",
          source: "shopee-affiliate"
        },
        { upsert: true, new: true }
      );
      console.info("POSTED_PRODUCT_HISTORY_SAVED", {
        userId: job.userId,
        productId,
        canonicalProductKey,
        pageId: job.targetPageId,
        postId: job.postId,
        jobId: job.payload?.workflowRunId ?? ""
      });
    }
  }

  await Promise.all(productIds.map((productId) => {
    const product = productById.get(productId) ?? { productId };
    return releaseShopeeProductReservation({
      userId: String(job.userId),
      canonicalProductKey: getShopeeCanonicalProductKey(product),
      jobId: String(job.payload?.workflowRunId ?? job._id ?? "")
    });
  }));

  await Promise.all(
    productIds.map((productId) =>
      AffiliatePerformance.findOneAndUpdate(
        {
          userId: job.userId,
          productId,
          pageId: job.targetPageId
        },
        {
          $inc: status === "published" ? { publishedPosts: 1 } : { failedPosts: 1 }
        },
        { upsert: true, new: true }
      )
    )
  );

  if (typeof job.payload?.aiGeneratedPostId === "string") {
    await AiGeneratedPost.findByIdAndUpdate(job.payload.aiGeneratedPostId, {
      status,
      errorCode: details.errorCode ?? null,
      errorMessage: details.failureReason ?? null
    });
  }
}

async function getWatermarkSettings(job: JobExecution) {
  const { autoPostConfigId, autoPostAiConfigId } = getBoundAutoPostConfigIds(job);

  if (autoPostAiConfigId) {
    const config = (await AutoPostAiConfig.findById(autoPostAiConfigId)
      .select("watermarkEnabled watermarkSource watermarkPosition watermarkSizePercent")
      .lean()) as
      | {
          watermarkEnabled?: boolean;
          watermarkSource?: "page_profile" | "custom_logo" | "none";
          watermarkPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
          watermarkSizePercent?: number;
        }
      | null;
    return {
      enabled: config?.watermarkEnabled !== false,
      source: config?.watermarkSource ?? "page_profile",
      position: config?.watermarkPosition ?? "bottom-right",
      sizePercent: config?.watermarkSizePercent ?? 17
    };
  }

  if (autoPostConfigId) {
    const config = (await AutoPostConfig.findById(autoPostConfigId)
      .select("watermarkEnabled watermarkSource watermarkPosition watermarkSizePercent")
      .lean()) as
      | {
          watermarkEnabled?: boolean;
          watermarkSource?: "page_profile" | "custom_logo" | "none";
          watermarkPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
          watermarkSizePercent?: number;
        }
      | null;
    return {
      enabled: config?.watermarkEnabled !== false,
      source: config?.watermarkSource ?? "page_profile",
      position: config?.watermarkPosition ?? "bottom-right",
      sizePercent: config?.watermarkSizePercent ?? 17
    };
  }

  return {
    enabled: false,
    source: "none" as const,
    position: "bottom-right" as const,
    sizePercent: 17
  };
}

async function updateBoundAutoPostState(
  job: JobExecution,
  configUpdates: Record<string, unknown>,
  recordUpdates: {
    autoPostStatus?: "idle" | "running" | "posting" | "success" | "partial_success" | "failed" | "retrying" | "paused" | "waiting";
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
    const aiConfigUpdates = { ...configUpdates };
    const aiRecordUpdates = { ...recordUpdates };

    // AutoPostAiConfig does not have a partial_success enum. Persist a completed
    // state instead of letting Mongoose reject the update and leave "posting" stuck.
    if (aiConfigUpdates.autoPostStatus === "partial_success") {
      aiConfigUpdates.autoPostStatus = "success";
      aiConfigUpdates.jobStatus = "posted";
      aiConfigUpdates.lastStatus = "posted";
    }

    if (aiRecordUpdates.autoPostStatus === "partial_success") {
      aiRecordUpdates.autoPostStatus = "success";
      aiRecordUpdates.currentJobStatus = "posted";
    }

    await AutoPostAiConfig.findByIdAndUpdate(autoPostAiConfigId, aiConfigUpdates);
    await updateAutoPostAiRecords({ configId: autoPostAiConfigId, ...aiRecordUpdates });
  }
}

async function updateBoundShopeeAutoPostRunState(job: JobExecution) {
  if (!isShopeeAffiliateJob(job) || !hasBoundAutoPostConfig(job)) {
    return false;
  }

  const { autoPostConfigId } = getBoundAutoPostConfigIds(job);
  if (!autoPostConfigId) {
    return false;
  }

  const workflowRunId = typeof job.payload?.workflowRunId === "string" ? job.payload.workflowRunId : null;
  const query: Record<string, unknown> = {
    userId: job.userId,
    type: "post",
    "payload.autoSource": "shopee-affiliate",
    "payload.autoPostConfigId": autoPostConfigId
  };

  if (workflowRunId) {
    query["payload.workflowRunId"] = workflowRunId;
  }

  const runJobs = await Job.find(query).sort({ createdAt: 1 }).lean();
  if (!runJobs.length) {
    return false;
  }

  const selectedPagesCount = Math.max(
    runJobs.length,
    ...runJobs
      .map((item) => Number((item.payload as Record<string, unknown> | undefined)?.selectedPagesCount ?? 0))
      .filter((value) => Number.isFinite(value))
  );
  const successCount = runJobs.filter((item) => item.status === "success").length;
  const failedJobs = runJobs.filter((item) => item.status === "failed" || item.status === "duplicate_blocked");
  const retryingCount = runJobs.filter((item) => item.status === "retrying" || item.status === "rate_limited").length;
  const activeCount = runJobs.filter((item) => item.status === "queued" || item.status === "processing").length;
  const failedCount = failedJobs.length;
  const pendingCount = Math.max(0, selectedPagesCount - successCount - failedCount);
  const latestFailure = failedJobs[failedJobs.length - 1] ?? null;
  const latestFailureMessage =
    latestFailure?.failureReason ||
    latestFailure?.lastError ||
    (latestFailure?.errorCode ? `Publish failed with ${latestFailure.errorCode}` : null);

  let autoPostStatus: "posting" | "success" | "partial_success" | "failed" | "retrying";
  let currentJobStatus: "pending" | "processing" | "posted" | "failed";
  let lastStatus: "pending" | "posted" | "failed";

  if (activeCount > 0) {
    autoPostStatus = "posting";
    currentJobStatus = "processing";
    lastStatus = "pending";
  } else if (retryingCount > 0) {
    autoPostStatus = "retrying";
    currentJobStatus = "pending";
    lastStatus = "pending";
  } else if (successCount === selectedPagesCount && selectedPagesCount > 0) {
    autoPostStatus = "success";
    currentJobStatus = "posted";
    lastStatus = "posted";
  } else if (successCount > 0 && failedCount > 0) {
    autoPostStatus = "partial_success";
    currentJobStatus = "failed";
    lastStatus = "failed";
  } else {
    autoPostStatus = "failed";
    currentJobStatus = "failed";
    lastStatus = "failed";
  }

  const summaryMessage =
    autoPostStatus === "success"
      ? `Published to all ${selectedPagesCount} selected page(s).`
      : autoPostStatus === "partial_success"
        ? `Published ${successCount}/${selectedPagesCount} page(s); ${failedCount} failed.`
        : autoPostStatus === "posting"
          ? `Publishing pages: ${successCount}/${selectedPagesCount} done, ${pendingCount} pending.`
          : autoPostStatus === "retrying"
            ? `Publishing paused for retry: ${successCount}/${selectedPagesCount} done, ${retryingCount} retrying.`
            : latestFailureMessage ?? "Publishing failed for all selected pages.";

  await updateBoundAutoPostState(
    job,
    {
      autoPostStatus,
      jobStatus: currentJobStatus,
      lastStatus,
      retryCount: Math.max(...runJobs.map((item) => Number(item.attempts ?? 0)), 0),
      lastError: autoPostStatus === "success" || autoPostStatus === "posting" ? null : latestFailureMessage ?? summaryMessage,
      lastPostId: job.postId,
      lastRunAt: new Date()
    },
    {
      autoPostStatus,
      currentJobStatus,
      lastError: autoPostStatus === "success" || autoPostStatus === "posting" ? null : latestFailureMessage ?? summaryMessage,
      message: summaryMessage,
      pageId: job.targetPageId,
      imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined,
      lastRunAt: new Date().toISOString()
    }
  );

  await logAction({
    userId: job.userId,
    type: "queue",
    level: autoPostStatus === "failed" ? "error" : autoPostStatus === "partial_success" ? "warn" : "info",
    message:
      autoPostStatus === "success"
        ? "JOB_SUCCESS: Shopee Affiliate Auto Post completed"
        : autoPostStatus === "partial_success"
          ? "JOB_PARTIAL_SUCCESS: Shopee Affiliate Auto Post completed with failed pages"
          : autoPostStatus === "failed"
            ? "JOB_FAILED: Shopee Affiliate Auto Post failed for all pages"
            : "START_PUBLISH_TO_PAGES: Shopee Affiliate Auto Post progress updated",
    relatedJobId: job._id,
    relatedPostId: job.postId,
    relatedScheduleId: job.scheduleId,
    metadata: {
      ...getAutoPostLogFlags(job),
      autoPostConfigId,
      workflowRunId,
      targetPageId: job.targetPageId,
      selectedPagesCount,
      successCount,
      failedCount,
      pendingCount,
      retryingCount,
      autoPostStatus,
      currentJobStatus,
      lastError: latestFailureMessage,
      correlationId: job.correlationId
    }
  });

  return true;
}

const SHOPEE_PUBLISH_MAX_HASHTAGS = 5;

function normalizeHashtags(hashtags?: string[]) {
  return (hashtags ?? [])
    .map((hashtag) => hashtag.trim())
    .filter(Boolean)
    .map((hashtag) => (hashtag.startsWith("#") ? hashtag : `#${hashtag}`));
}

function normalizeShopeePublishHashtags(message: string) {
  const hashtags: string[] = [];
  const contentLines = message
    .split(/\r?\n/)
    .map((line) => {
      const matches = line.match(/#[^\s#]+/g) ?? [];
      hashtags.push(...matches.map((tag) => tag.trim()).filter(Boolean));
      return line.replace(/#[^\s#]+/g, "").trimEnd();
    });

  const uniqueHashtags = Array.from(new Set(hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)))).slice(
    0,
    SHOPEE_PUBLISH_MAX_HASHTAGS
  );

  const body = contentLines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!uniqueHashtags.length) return body;
  return `${body}\n\n${uniqueHashtags.join(" ")}`.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(value: string, maxChars: number, maxLines: number) {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\.*$/, "")}...`;
  }
  return lines;
}

async function fetchRemoteImageBuffer(url: string) {
  if (url.startsWith("data:image/")) {
    const match = url.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    if (!match?.[1]) {
      throw new Error("Invalid generated Shopee data image");
    }
    return Buffer.from(match[1], "base64");
  }

  const requestStartedAt = Date.now();
  const response = await traceExternalRequest(
    {
      step: "FACEBOOK_IMAGE_SOURCE_FETCH",
      url,
      fn: "fetchRemoteImageBuffer",
      source: "facebook_publish_image_fetch"
    },
    () => fetch(url, { cache: "no-store" })
  );
  if (!response.ok) {
    await logExternalResponseFailure({
      step: "FACEBOOK_IMAGE_SOURCE_FETCH",
      url,
      fn: "fetchRemoteImageBuffer",
      source: "facebook_publish_image_fetch",
      responseTime: Date.now() - requestStartedAt,
      status: response.status,
      errorMessage: `Unable to fetch Shopee product image: ${response.status}`
    });
    throw new Error(`Unable to fetch Shopee product image: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}


function getShopeeUgcLayout(promptHistory?: string[]) {
  const layoutEntry = (promptHistory ?? []).find((item) => item.startsWith("layout="));
  const layout = Number(layoutEntry?.replace("layout=", "") ?? "1");
  return Number.isFinite(layout) && layout >= 1 && layout <= 4 ? layout : 1;
}

function truncateText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function formatShopeePrice(product: LeanShopeeProduct) {
  const price = product.discountPrice || product.productPrice || 0;
  return price ? `\u0e3f${price.toLocaleString("th-TH")}` : "\u0e40\u0e0a\u0e47\u0e01\u0e23\u0e32\u0e04\u0e32\u0e43\u0e19 Shopee";
}

function getShopeeProductScene(product: LeanShopeeProduct) {
  const text = `${product.productName} ${product.productDescription ?? ""} ${product.category ?? ""}`.toLowerCase();
  if (/car|tire|tyre|garage|wheel/.test(text)) {
    return { bg1: "#dbe4ed", bg2: "#f8fafc", surface: "#cbd5e1", prop: "garage", accent: "#2563eb" };
  }
  if (/camp|power|station|battery|outdoor|travel/.test(text)) {
    return { bg1: "#d9ead3", bg2: "#fff7ed", surface: "#d6a96f", prop: "camping", accent: "#16a34a" };
  }
  if (/crocs|shoe|sneaker|slipper|sandals/.test(text)) {
    return { bg1: "#fce7f3", bg2: "#fff7ed", surface: "#f3d7c4", prop: "bedroom", accent: "#db2777" };
  }
  if (/bag|travel|cafe|wallet|pouch/.test(text)) {
    return { bg1: "#fde68a", bg2: "#fef3c7", surface: "#d7a66c", prop: "cafe", accent: "#f97316" };
  }
  if (/gadget|phone|usb|charger|desk|earbud|earphone|speaker|headphone/.test(text)) {
    return { bg1: "#dbeafe", bg2: "#f8fafc", surface: "#c7b7a3", prop: "desk", accent: "#0ea5e9" };
  }
  return { bg1: "#f5f0e8", bg2: "#f8fafc", surface: "#dec9aa", prop: "home", accent: "#f97316" };
}

function getShopeeUgcCopy(product: LeanShopeeProduct, layout: number) {
  const priceText = formatShopeePrice(product);
  const discountText = product.discountPercent ? `\u0e25\u0e14 ${product.discountPercent}%` : "\u0e14\u0e35\u0e25\u0e19\u0e48\u0e32\u0e40\u0e0a\u0e47\u0e01";
  const ratingText = product.rating ? `\u0e23\u0e35\u0e27\u0e34\u0e27 ${product.rating}/5` : "\u0e23\u0e35\u0e27\u0e34\u0e27\u0e14\u0e35";
  const salesText = product.salesCount ? `\u0e02\u0e32\u0e22\u0e41\u0e25\u0e49\u0e27 ${product.salesCount.toLocaleString("th-TH")}+` : "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e21\u0e32\u0e41\u0e23\u0e07";
  const categoryText = product.category || "\u0e02\u0e2d\u0e07\u0e19\u0e48\u0e32\u0e43\u0e0a\u0e49";
  const shortName = truncateText(product.productName, 34);

  if (layout === 1) {
    return { label: "\u0e23\u0e35\u0e27\u0e34\u0e27\u0e08\u0e32\u0e01\u0e23\u0e39\u0e1b\u0e08\u0e23\u0e34\u0e07", lines: ["\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32\u0e40\u0e15\u0e47\u0e21\u0e40\u0e1f\u0e23\u0e21 \u0e40\u0e2b\u0e47\u0e19\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e0a\u0e31\u0e14", `\u0e23\u0e32\u0e04\u0e32 ${priceText} - ${discountText}`, shortName], chips: [priceText, discountText, ratingText] };
  }
  if (layout === 2) {
    return { label: "\u0e0b\u0e39\u0e21\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14", lines: ["\u0e14\u0e39\u0e14\u0e35\u0e40\u0e17\u0e25\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32\u0e43\u0e01\u0e25\u0e49 \u0e46", product.shopName ? `\u0e23\u0e49\u0e32\u0e19 ${truncateText(product.shopName, 22)}` : categoryText, ratingText], chips: [ratingText, salesText, discountText] };
  }
  if (layout === 3) {
    return { label: "\u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19\u0e08\u0e23\u0e34\u0e07", lines: ["\u0e40\u0e2b\u0e21\u0e32\u0e30\u0e01\u0e31\u0e1a\u0e43\u0e0a\u0e49\u0e43\u0e19\u0e0a\u0e35\u0e27\u0e34\u0e15\u0e1b\u0e23\u0e30\u0e08\u0e33\u0e27\u0e31\u0e19", `\u0e2b\u0e21\u0e27\u0e14 ${categoryText}`, salesText], chips: [salesText, discountText, "\u0e14\u0e39\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e37\u0e49\u0e2d"] };
  }
  return { label: "\u0e01\u0e14\u0e14\u0e39\u0e43\u0e19\u0e41\u0e04\u0e1b\u0e0a\u0e31\u0e48\u0e19", lines: ["\u0e43\u0e04\u0e23\u0e21\u0e2d\u0e07\u0e2b\u0e32\u0e41\u0e19\u0e27\u0e19\u0e35\u0e49", "\u0e01\u0e14\u0e14\u0e39\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e44\u0e14\u0e49\u0e40\u0e25\u0e22", `\u0e23\u0e32\u0e04\u0e32 ${priceText}`], chips: [priceText, "\u0e19\u0e48\u0e32\u0e43\u0e0a\u0e49\u0e21\u0e32\u0e01", salesText] };
}
function buildShopeeUgcSceneSvg(input: { scene: ReturnType<typeof getShopeeProductScene>; layout: number }) {
  const { scene, layout } = input;
  const propSvg =
    scene.prop === "garage"
      ? `<rect x="72" y="725" width="220" height="76" rx="18" fill="#334155" opacity="0.18"/><circle cx="118" cy="825" r="28" fill="#111827" opacity="0.16"/><circle cx="246" cy="825" r="28" fill="#111827" opacity="0.16"/><path d="M780 730h180l44 92H736z" fill="#64748b" opacity="0.18"/>`
      : scene.prop === "camping"
        ? `<path d="M72 760l116-176 116 176z" fill="#92400e" opacity="0.18"/><path d="M122 760l66-102 66 102z" fill="#fef3c7" opacity="0.42"/><circle cx="900" cy="192" r="68" fill="#facc15" opacity="0.32"/><path d="M756 808c48-66 124-86 210-46" fill="none" stroke="#166534" stroke-width="16" opacity="0.16"/>`
        : scene.prop === "bedroom"
          ? `<rect x="66" y="748" width="286" height="86" rx="32" fill="#fb7185" opacity="0.18"/><circle cx="146" cy="720" r="58" fill="#fbcfe8" opacity="0.46"/><rect x="774" y="724" width="210" height="126" rx="36" fill="#fda4af" opacity="0.15"/>`
          : scene.prop === "cafe"
            ? `<circle cx="152" cy="742" r="72" fill="#7c2d12" opacity="0.13"/><rect x="92" y="742" width="126" height="90" rx="22" fill="#fef3c7" opacity="0.54"/><path d="M826 716h114c20 0 36 16 36 36v18c0 20-16 36-36 36H826z" fill="#92400e" opacity="0.13"/>`
            : scene.prop === "desk"
              ? `<rect x="66" y="720" width="218" height="132" rx="24" fill="#0f172a" opacity="0.13"/><rect x="802" y="696" width="150" height="210" rx="26" fill="#38bdf8" opacity="0.18"/><circle cx="888" cy="780" r="42" fill="#ffffff" opacity="0.28"/>`
              : `<rect x="82" y="738" width="210" height="96" rx="32" fill="#a16207" opacity="0.13"/><circle cx="888" cy="746" r="82" fill="#fbbf24" opacity="0.16"/>`;
  const angleLines =
    layout === 4
      ? `<path d="M-40 304 C240 244 492 276 1120 132" fill="none" stroke="${scene.accent}" stroke-width="24" opacity="0.12"/>`
      : `<path d="M-20 220 C236 126 430 164 1100 92" fill="none" stroke="${scene.accent}" stroke-width="18" opacity="0.10"/>`;

  return `
    <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sceneBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${scene.bg1}" stop-opacity="0.78"/>
          <stop offset="58%" stop-color="${scene.bg2}" stop-opacity="0.72"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0.5"/>
        </linearGradient>
      </defs>
      <rect width="1080" height="1080" fill="url(#sceneBg)"/>
      ${angleLines}
      <circle cx="930" cy="122" r="166" fill="${scene.accent}" opacity="0.12"/>
      <circle cx="98" cy="956" r="214" fill="${scene.accent}" opacity="0.08"/>
      <path d="M0 760 C214 694 386 720 540 770 C694 820 856 820 1080 744 L1080 1080 L0 1080 Z" fill="${scene.surface}" opacity="0.78"/>
      <path d="M0 804 C214 740 400 760 558 812 C708 862 882 858 1080 790 L1080 1080 L0 1080 Z" fill="#ffffff" opacity="0.24"/>
      ${propSvg}
      <ellipse cx="540" cy="842" rx="420" ry="72" fill="#0f172a" opacity="0.18"/>
      <ellipse cx="550" cy="806" rx="330" ry="38" fill="#ffffff" opacity="0.18"/>
    </svg>
  `;
}

async function renderShopeeAffiliateCard(imageDoc: LeanAiGeneratedImage): Promise<ResolvedImage> {
  const product = (await ShopeeProduct.findOne({ productId: imageDoc.productId }).lean()) as LeanShopeeProduct | null;
  if (!product) {
    throw new Error("Shopee product not found for generated image");
  }

  const layout = getShopeeUgcLayout(imageDoc.promptHistory);
  const imageUrl = imageDoc.generatedImageUrl || imageDoc.fallbackImageUrl || product.productImageUrl || product.productImageUrls?.[0];
  if (!imageUrl) {
    throw new Error("Shopee product image is missing");
  }
  const productBuffer = await fetchRemoteImageBuffer(imageUrl);

  const output = await sharp(productBuffer)
    .resize(1080, 1080, {
      fit: "cover",
      position: "attention",
      withoutEnlargement: false
    })
    .jpeg({ quality: 94 })
    .toBuffer();

  return {
    kind: "binary",
    fileName: `shopee-${product.productId}-ugc-${layout}.jpg`,
    bytes: Uint8Array.from(output).buffer,
    mimeType: "image/jpeg"
  };
}

async function ensureShopeeAffiliateImageRefs(job: JobExecution, post: LeanPost) {
  if (!isShopeeAffiliateJob(job)) {
    return post.imageUrls;
  }

  if (post.imageUrls.length >= 4 && post.imageUrls.every((ref) => ref.startsWith("ai-image:"))) {
    return post.imageUrls;
  }

  const aiGeneratedPostId = typeof job.payload?.aiGeneratedPostId === "string" ? job.payload.aiGeneratedPostId : null;
  if (aiGeneratedPostId) {
    const aiPost = await AiGeneratedPost.findById(aiGeneratedPostId).lean<{
      generationMetaJson?: { generatedImageUrls?: unknown };
    } | null>();
    const metaRefs = Array.isArray(aiPost?.generationMetaJson?.generatedImageUrls)
      ? aiPost.generationMetaJson.generatedImageUrls.filter((ref): ref is string => typeof ref === "string" && ref.startsWith("ai-image:"))
      : [];
    if (metaRefs.length >= 4) {
      await Post.findByIdAndUpdate(post._id, { imageUrls: metaRefs.slice(0, 4) });
      return metaRefs.slice(0, 4);
    }
  }

  await logAction({
    userId: job.userId,
    type: "queue",
    level: "error",
    message: "Blocked Shopee Affiliate publish because generated UGC images are missing",
    relatedJobId: job._id,
    relatedPostId: job.postId,
    relatedScheduleId: job.scheduleId,
    metadata: {
      ...getAutoPostLogFlags(job),
      previousImageCount: post.imageUrls.length,
      sourceImageFallbackDisabled: true
    }
  });

  throw new Error("Shopee Affiliate post validation failed: generated UGC images are missing; source-image fallback is disabled");
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

async function validateShopeeAffiliatePublishPayload(input: {
  job: JobExecution;
  message: string;
  imageCount: number;
}) {
  const reasons: string[] = [];
  const failureDetails: Array<{
    failedRule: string;
    matchedText?: string;
    validatorName: string;
  }> = [];
  const validatorName = "validateShopeeAffiliatePublishPayload";
  const enabledRules = [
    "caption_exists",
    "caption_encoding_valid",
    "generated_images_complete",
    "shopee_short_link_exists",
    "shopee_link_same_line_as_pin",
    "no_internal_redirect_url",
    "no_affiliate_disclosure",
    "facebook_caption_length_limit",
    "no_forbidden_hallucination_phrases"
  ];
  const normalizedMessage = normalizeTextEncoding(input.message);
  const encodingValidation = validateTextEncoding(normalizedMessage, "Shopee publish caption");
  const shopeeLinkMatch = normalizedMessage.match(/https:\/\/s\.shopee\.co\.th\/\S+/);
  const shopeePinLinkMatch = normalizedMessage.match(/📍\s*พิกัด\s+https:\/\/s\.shopee\.co\.th\/\S+/u);
  const payloadAffiliateLink = typeof input.job.payload?.affiliateLink === "string" ? input.job.payload.affiliateLink : "";
  const forbiddenHallucinationPatterns = [
    /จากรูปสินค้า/iu,
    /จากภาพสินค้า/iu,
    /จากภาพ/iu,
    /จากชื่อสินค้า/iu,
    /จากข้อมูลสินค้า/iu,
    /จากข้อมูลที่ระบุ/iu,
    /จากรายละเอียดสินค้า/iu,
    /จากคำอธิบายสินค้า/iu,
    /ตามข้อมูล/iu,
    /ตามภาพ/iu,
    /เห็นได้จากภาพ/iu,
    /วิเคราะห์จากภาพ/iu,
    /กระบวนการวิเคราะห์/iu
  ];
  const addFailure = (failedRule: string, message: string, matchedText?: string) => {
    reasons.push(message);
    failureDetails.push({ failedRule, matchedText, validatorName });
  };

  console.info("[SHOPEE_POST_VALIDATION_RULES]", {
    validatorName,
    enabledRules
  });

  if (!normalizedMessage.trim()) {
    addFailure("caption_exists", "Caption is empty");
  }
  if (!encodingValidation.ok) {
    addFailure(
      "caption_encoding_valid",
      `Caption encoding is corrupted: ${encodingValidation.markers.join(", ")}`,
      encodingValidation.markers.join(", ")
    );
  }
  if (input.imageCount !== 4) {
    addFailure("generated_images_complete", "Shopee Affiliate post requires exactly 4 generated images");
  }
  if (!shopeeLinkMatch || !isShopeeShortLink(shopeeLinkMatch[0])) {
    addFailure(
      "shopee_short_link_exists",
      "Caption must include a valid Shopee short link starting with https://s.shopee.co.th/",
      shopeeLinkMatch?.[0]
    );
  }
  if (!shopeePinLinkMatch) {
    addFailure("shopee_link_same_line_as_pin", "Shopee short link must be on the same line as 📍 พิกัด");
  }
  if (/📍\s*พิกัด\s*\r?\n\s*https:\/\/s\.shopee\.co\.th\//iu.test(normalizedMessage)) {
    addFailure("shopee_link_same_line_as_pin", "Caption uses old two-line Shopee link format");
  }
  if (payloadAffiliateLink && !isShopeeShortLink(payloadAffiliateLink)) {
    addFailure("shopee_short_link_exists", "Queued affiliate link is not a Shopee short link", payloadAffiliateLink);
  }
  if (/prosocial-app-theta\.vercel\.app|\/api\/s\//i.test(normalizedMessage)) {
    addFailure("no_internal_redirect_url", "Caption contains an internal redirect URL");
  }
  if (normalizedMessage.includes("\u0e2b\u0e21\u0e32\u0e22\u0e40\u0e2b\u0e15\u0e38")) {
    addFailure(
      "no_affiliate_disclosure",
      "Caption contains forbidden disclosure word: \u0e2b\u0e21\u0e32\u0e22\u0e40\u0e2b\u0e15\u0e38",
      "\u0e2b\u0e21\u0e32\u0e22\u0e40\u0e2b\u0e15\u0e38"
    );
  }
  if (normalizedMessage.toLowerCase().includes("affiliate")) {
    addFailure("no_affiliate_disclosure", "Caption contains forbidden disclosure word: affiliate", "affiliate");
  }
  if (normalizedMessage.length > 63000) {
    addFailure(
      "facebook_caption_length_limit",
      `Caption exceeds Facebook post length limit (${normalizedMessage.length}/63000 characters)`
    );
  }
  for (const pattern of forbiddenHallucinationPatterns) {
    const matchedText = normalizedMessage.match(pattern)?.[0];
    if (matchedText) {
      addFailure(
        "no_forbidden_hallucination_phrases",
        "Caption contains forbidden source/hallucination wording",
        matchedText
      );
    }
  }

  if (reasons.length === 0) {
    return;
  }

  await logAction({
    userId: input.job.userId,
    type: "queue",
    level: "error",
    message: encodingValidation.ok
      ? "Shopee Affiliate validation failed before Facebook publish"
      : "[Encoding Error Detected] Shopee caption failed UTF-8 validation before Facebook publish",
    relatedJobId: input.job._id,
    relatedPostId: input.job.postId,
    relatedScheduleId: input.job.scheduleId,
    metadata: {
      ...getAutoPostLogFlags(input.job),
      targetPageId: input.job.targetPageId,
      imageCount: input.imageCount,
      reasons,
      failedRules: failureDetails
    }
  });

  console.warn("[SHOPEE_POST_VALIDATION_FAILED_DETAIL]", {
    validatorName,
    failedRules: failureDetails
  });

  throw new Error(`Shopee Affiliate post validation failed: ${reasons.join("; ")}`);
}

function resolveShopeeFacebookAttachmentLink(job: JobExecution, message: string) {
  const payloadAffiliateLink = typeof job.payload?.affiliateLink === "string" ? job.payload.affiliateLink.trim() : "";
  if (payloadAffiliateLink && isShopeeShortLink(payloadAffiliateLink)) {
    return payloadAffiliateLink;
  }

  const captionLink = message.match(/https:\/\/s\.shopee\.co\.th\/\S+/)?.[0]?.trim();
  if (captionLink && isShopeeShortLink(captionLink)) {
    return captionLink;
  }

  return undefined;
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
    if (ref.startsWith("ai-image:")) {
      const imageId = ref.replace("ai-image:", "");
      const imageDoc = (await AiGeneratedImage.findById(imageId).lean()) as LeanAiGeneratedImage | null;
      if (!imageDoc) {
        throw new Error("Generated Shopee image is no longer available");
      }
      images.push(await renderShopeeAffiliateCard(imageDoc));
      continue;
    }

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
  const steps = [1 * 60_000, 3 * 60_000, 5 * 60_000];
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

  if (
    normalized.includes("signal is aborted") ||
    normalized.includes("aborterror") ||
    normalized.includes("aborted") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout")
  ) {
    return {
      errorCode: "job_aborted_or_timeout",
      failureReason:
        message === "Unknown publishing error"
          ? "Publish job was aborted or timed out before it could complete."
          : message,
      errorDetails: error instanceof Error ? serializeError(error) : { reason: message },
      retryable: true
    };
  }

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

  await Job.updateMany(
    {
      ...(jobType ? { type: jobType } : {}),
      status: "processing",
      lockExpiresAt: { $lte: now }
    },
    {
      $set: {
        status: "retrying",
        nextRunAt: now,
        nextRetryAt: now,
        lastError: "Job lock expired before completion; re-queued automatically",
        failureReason: "Job lock expired before completion; re-queued automatically",
        errorCode: "job_lock_expired"
      },
      $unset: {
        lockedAt: "",
        lockExpiresAt: ""
      }
    }
  );

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
  const pageTaskStageDone = startQueueStageTimer("PAGE_TASK_CREATE", {
    userId,
    postId,
    autoSource: options.payloadExtras?.autoSource,
    autoPostConfigId: options.payloadExtras?.autoPostConfigId,
    workflowRunId: options.payloadExtras?.workflowRunId
  });
  try {
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

    const isAutoPostPageTask = Boolean(options.payloadExtras?.autoPostConfigId || options.payloadExtras?.autoPostAiConfigId);
    const isShopeePageTask = options.payloadExtras?.autoSource === "shopee-affiliate";
    const spacingMinutes = isAutoPostPageTask ? AUTO_POST_PAGE_SPACING_MINUTES : 0;
    const baseRunAt = options.startAt
      ? new Date(options.startAt)
      : options.forceImmediate || options.applyRandomDelay === false
        ? new Date()
        : new Date(Date.now() + randomDelayMs(safeSettings.minDelaySeconds, safeSettings.maxDelaySeconds));
    const nextRunAt =
      isShopeePageTask || options.payloadExtras?.autoPostAiConfigId
        ? new Date(baseRunAt.getTime() + pageIndex * spacingMinutes * 60 * 1000)
        : options.forceImmediate
          ? new Date()
          : baseRunAt;

    const jobCreateStageDone = startQueueStageTimer("DATABASE_SAVE", {
      collection: "Job",
      userId,
      postId,
      pageId: page.pageId,
      pageName: page.name ?? "Facebook Page",
      pageIndex: pageIndex + 1,
      selectedPagesCount: selectedPages.length,
      nextRunAt: nextRunAt.toISOString(),
      autoSource: options.payloadExtras?.autoSource,
      workflowRunId: options.payloadExtras?.workflowRunId
    });
    let job: any;
    try {
      job = await Job.create({
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
          ...(options.payloadExtras ?? {}),
          ...(isShopeePageTask
            ? {
                pageIndex: pageIndex + 1,
                selectedPagesCount: selectedPages.length,
                scheduledDelayMinutes: pageIndex * spacingMinutes
              }
            : {})
        },
        nextRunAt,
        maxAttempts: 3,
        status: "queued"
      });
      jobCreateStageDone("success", { jobId: String(job._id) });
    } catch (error) {
      jobCreateStageDone("failed", {}, error);
      throw error;
    }

    if (options.payloadExtras?.autoSource === "shopee-affiliate") {
      const autoPostConfigId = String(options.payloadExtras.autoPostConfigId ?? "");
      const workflowRunId = String(options.payloadExtras.workflowRunId ?? "");
      await logAction({
        userId,
        type: "queue",
        level: "info",
        message: "PAGE_RESULT_CREATED: Shopee page publish task created",
        metadata: {
          autoPost: true,
          autoSource: "shopee-affiliate",
          autoPostConfigId,
          workflowRunId,
          step: "PAGE_RESULT_CREATED",
          jobId: String(job._id),
          pageId: page.pageId,
          pageName: page.name ?? "Facebook Page",
          status: "queued",
          nextRunAt: nextRunAt.toISOString(),
          forceImmediate: Boolean(options.forceImmediate),
          pageIndex: pageIndex + 1,
          selectedPagesCount: selectedPages.length,
          scheduledDelayMinutes: pageIndex * spacingMinutes
        }
      });
      await logAction({
        userId,
        type: "queue",
        level: "info",
        message: "PAGE_QUEUED: Shopee page publish task queued",
        metadata: {
          autoPost: true,
          autoSource: "shopee-affiliate",
          autoPostConfigId,
          workflowRunId,
          step: "PAGE_QUEUED",
          jobId: String(job._id),
          pageId: page.pageId,
          pageName: page.name ?? "Facebook Page",
          status: "queued",
          nextRunAt: nextRunAt.toISOString(),
          pageIndex: pageIndex + 1,
          selectedPagesCount: selectedPages.length,
          scheduledDelayMinutes: pageIndex * spacingMinutes
        }
      });
      await logAction({
        userId,
        type: "queue",
        level: "info",
        message: "PAGE_TASK_SCHEDULED: Shopee page publish task scheduled",
        metadata: {
          autoPost: true,
          autoSource: "shopee-affiliate",
          autoPostConfigId,
          workflowRunId,
          step: "PAGE_TASK_SCHEDULED",
          jobId: String(job._id),
          pageId: page.pageId,
          pageName: page.name ?? "Facebook Page",
          status: "queued",
          scheduledAt: nextRunAt.toISOString(),
          pageIndex: pageIndex + 1,
          selectedPagesCount: Number(options.payloadExtras?.selectedPagesCount ?? selectedPages.length),
          scheduledDelayMinutes: pageIndex * spacingMinutes
        }
      });
    }

    queued += 1;
  }

  if (options.payloadExtras?.autoSource === "shopee-affiliate" && queued !== selectedPages.length) {
    await logAction({
      userId,
      type: "queue",
      level: "error",
      message: "Page task creation incomplete",
      metadata: {
        autoPost: true,
        autoSource: "shopee-affiliate",
        autoPostConfigId: String(options.payloadExtras.autoPostConfigId ?? ""),
        workflowRunId: String(options.payloadExtras.workflowRunId ?? ""),
        selectedPagesCount: selectedPages.length,
        createdTasksCount: queued
      }
    });
    throw new Error("Page task creation incomplete");
  }

  pageTaskStageDone("success", {
    queued,
    selectedPagesCount: selectedPages.length,
    targetPageIds: selectedPages.map((page) => page.pageId)
  });
  return queued;
  } catch (error) {
    pageTaskStageDone("failed", {}, error);
    throw error;
  }
}

export async function repairMissingShopeePageTasks(userId: string, config: Record<string, any>, workflowRunId?: string | null) {
  const configId = String(config._id ?? "");
  const targetPageIds = Array.from(
    new Set(
      (Array.isArray(config.targetPageIds) ? config.targetPageIds : [])
        .map((pageId: unknown) => String(pageId ?? "").trim())
        .filter(Boolean)
    )
  );

  if (!configId || targetPageIds.length === 0) {
    return { created: 0, expected: targetPageIds.length };
  }

  const baseRunQuery: Record<string, unknown> = {
    userId,
    type: "post",
    "payload.autoSource": "shopee-affiliate",
    "payload.autoPostConfigId": configId
  };

  const loadRunJobs = async (query: Record<string, unknown>) =>
    (await Job.find(query)
      .sort({ createdAt: 1 })
      .select("_id postId targetPageId payload nextRunAt createdAt status")
      .lean()) as Array<Record<string, any>>;

  const runQuery: Record<string, unknown> = { ...baseRunQuery };
  if (workflowRunId) {
    runQuery["payload.workflowRunId"] = workflowRunId;
  }

  let runJobs = await loadRunJobs(runQuery);

  // Production recovery: sometimes the config points at a workflowRunId whose
  // task creation timed out after the first page. If that query cannot provide
  // a usable template, fall back to the latest Shopee job for this config so we
  // can clone the already prepared post/caption/images into the missing pages.
  if (!runJobs.some((job) => job.postId)) {
    const latestTemplateJob = (await Job.findOne({
      ...baseRunQuery,
      postId: { $exists: true, $ne: null }
    })
      .sort({ createdAt: -1 })
      .select("payload")
      .lean()) as Record<string, any> | null;
    const fallbackWorkflowRunId =
      typeof latestTemplateJob?.payload?.workflowRunId === "string"
        ? latestTemplateJob.payload.workflowRunId
        : null;
    if (fallbackWorkflowRunId && fallbackWorkflowRunId !== workflowRunId) {
      runJobs = await loadRunJobs({ ...baseRunQuery, "payload.workflowRunId": fallbackWorkflowRunId });
      workflowRunId = fallbackWorkflowRunId;
    } else if (!runJobs.length) {
      runJobs = await loadRunJobs(baseRunQuery);
    }
  }

  const existingPageIds = new Set(runJobs.map((job) => String(job.targetPageId ?? "")).filter(Boolean));
  const missingPageIds = targetPageIds.filter((pageId) => !existingPageIds.has(pageId));
  if (!missingPageIds.length) {
    return { created: 0, expected: targetPageIds.length };
  }

  const templateJob = runJobs.find((job) => job.postId && job.payload?.autoSource === "shopee-affiliate");
  if (!templateJob?.postId) {
    await logAction({
      userId,
      type: "queue",
      level: "error",
      message: "PAGE_TASK_REPAIR_FAILED: No Shopee template post found for missing page tasks",
      metadata: {
        autoPost: true,
        autoSource: "shopee-affiliate",
        autoPostConfigId: configId,
        workflowRunId,
        selectedPagesCount: targetPageIds.length,
        existingTasksCount: runJobs.length,
        missingPageIds
      }
    });
    return { created: 0, expected: targetPageIds.length };
  }

  const templatePost = (await Post.findById(templateJob.postId).lean()) as LeanPost | null;
  if (!templatePost) {
    await logAction({
      userId,
      type: "queue",
      level: "error",
      message: "PAGE_TASK_REPAIR_FAILED: Shopee template post was not found",
      metadata: {
        autoPost: true,
        autoSource: "shopee-affiliate",
        autoPostConfigId: configId,
        workflowRunId,
        postId: String(templateJob.postId),
        missingPageIds
      }
    });
    return { created: 0, expected: targetPageIds.length };
  }

  const baseRunAt = runJobs
    .map((job) => (job.nextRunAt ? new Date(job.nextRunAt) : job.createdAt ? new Date(job.createdAt) : null))
    .filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())))
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? new Date();
  const now = new Date();
  const templatePayload = (templateJob.payload ?? {}) as Record<string, unknown>;
  const activeWorkflowRunId =
    workflowRunId ||
    (typeof templatePayload.workflowRunId === "string" ? templatePayload.workflowRunId : "") ||
    String(config.lastWorkflowRunId ?? "");

  let created = 0;
  for (const pageId of missingPageIds) {
    const pageIndex = Math.max(0, targetPageIds.indexOf(pageId));
    const scheduledAt = new Date(baseRunAt.getTime() + pageIndex * AUTO_POST_PAGE_SPACING_MINUTES * 60 * 1000);
    const nextRunAt = scheduledAt.getTime() <= now.getTime() ? now : scheduledAt;
    const fingerprint = contentFingerprint({
      content: templatePost.content,
      hashtags: templatePost.hashtags,
      imageUrls: templatePost.imageUrls,
      targetPageIds: [pageId]
    });

    const job = await Job.create({
      userId,
      type: "post",
      postId: templatePost._id,
      targetPageId: pageId,
      fingerprint,
      payload: {
        ...templatePayload,
        autoPostConfigId: configId,
        autoSource: "shopee-affiliate",
        workflowRunId: activeWorkflowRunId,
        selectedPagesCount: targetPageIds.length,
        pageIndex: pageIndex + 1,
        scheduledDelayMinutes: pageIndex * AUTO_POST_PAGE_SPACING_MINUTES,
        repairedMissingPageTask: true,
        repairedAt: now.toISOString()
      },
      nextRunAt,
      maxAttempts: 3,
      status: "queued"
    });

    created += 1;
    await logAction({
      userId,
      type: "queue",
      level: "warn",
      message: "PAGE_TASK_REPAIRED: Missing Shopee page publish task created",
      metadata: {
        autoPost: true,
        autoSource: "shopee-affiliate",
        autoPostConfigId: configId,
        workflowRunId: activeWorkflowRunId,
        step: "PAGE_TASK_REPAIRED",
        jobId: String(job._id),
        pageId,
        pageName: "Facebook Page",
        status: "queued",
        scheduledAt: nextRunAt.toISOString(),
        pageIndex: pageIndex + 1,
        selectedPagesCount: targetPageIds.length,
        scheduledDelayMinutes: pageIndex * AUTO_POST_PAGE_SPACING_MINUTES
      }
    });
  }

  return { created, expected: targetPageIds.length };
}

export async function retryPendingShopeePageJobs(userId: string, configId?: string) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 3 * 60 * 1000);
  const config = configId
    ? await AutoPostConfig.findOne({ _id: configId, userId }).lean()
    : await AutoPostConfig.findOne({ userId, contentSource: "shopee-affiliate" }).sort({ updatedAt: -1 }).lean();

  if (!config) {
    throw new Error("Shopee Affiliate Auto Post settings not found");
  }

  const workflowRunId = (config as any).lastWorkflowRunId ? String((config as any).lastWorkflowRunId) : null;
  const repaired = await repairMissingShopeePageTasks(userId, config as Record<string, any>, workflowRunId);
  const query: Record<string, unknown> = {
    userId,
    type: "post",
    status: { $in: ["queued", "retrying", "rate_limited"] },
    "payload.autoSource": "shopee-affiliate",
    "payload.autoPostConfigId": String((config as any)._id),
    $or: [
      { nextRunAt: { $lte: now } },
      { createdAt: { $lte: staleBefore }, nextRunAt: { $lte: now } }
    ]
  };
  if (workflowRunId) {
    query["payload.workflowRunId"] = workflowRunId;
  }

  const stuckJobs = (await Job.find(query)
    .sort({ nextRunAt: 1 })
    .limit(20)
    .select("_id targetPageId payload nextRunAt createdAt status")
    .lean()) as Array<Record<string, any>>;

  if (!stuckJobs.length) {
    return {
      requeued: repaired.created,
      processed: 0,
      message: repaired.created
        ? `Created ${repaired.created} missing Shopee page task(s)`
        : "No pending Shopee page jobs found"
    };
  }

  const jobIds = stuckJobs.map((job) => job._id);
  await Job.updateMany(
    { _id: { $in: jobIds } },
    {
      $set: {
        status: "queued",
        nextRunAt: now,
        nextRetryAt: null,
        lockExpiresAt: null,
        lockedAt: null,
        lastError: null,
        failureReason: null,
        errorCode: null
      }
    }
  );

  for (const job of stuckJobs) {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    await logAction({
      userId,
      type: "queue",
      level: "warn",
      message: "PAGE_PENDING_TIMEOUT_REQUEUED: Shopee page publish task was re-queued",
      metadata: {
        autoPost: true,
        autoSource: "shopee-affiliate",
        autoPostConfigId: String((config as any)._id),
        workflowRunId: String(payload.workflowRunId ?? workflowRunId ?? ""),
        step: "PAGE_PENDING_TIMEOUT_REQUEUED",
        jobId: String(job._id),
        pageId: String(job.targetPageId ?? ""),
        previousStatus: String(job.status ?? "queued"),
        previousNextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
        requeuedAt: now.toISOString()
      }
    });
  }

  await AutoPostConfig.findByIdAndUpdate((config as any)._id, {
    autoPostStatus: "posting",
    jobStatus: "pending",
    lastStatus: "pending",
    lastError: null
  });

  await updateAutoPostRecords({
    configId: String((config as any)._id),
    autoPostStatus: "posting",
    currentJobStatus: "pending",
    message: "Re-queued pending Shopee page publish tasks"
  });

  const processed = await processQueuedJobs(Math.min(stuckJobs.length, 10), "post");

  return {
    requeued: stuckJobs.length + repaired.created,
    processed
  };
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

async function autoCommentFinalCaptionUnderPost(input: {
  job: JobExecution;
  pageId: string;
  pageAccessToken: string;
  pageName?: string;
  postId?: string;
  facebookPostId?: string;
  finalCaption: string;
}) {
  const autoPostConfigId = (input.job.payload as Record<string, unknown> | undefined)?.autoPostConfigId;
  const commentConfig = autoPostConfigId
    ? ((await AutoPostConfig.findById(autoPostConfigId as string)
        .select("autoCommentCaptionAfterPublish autoCommentDelaySeconds")
        .lean()) as { autoCommentCaptionAfterPublish?: boolean; autoCommentDelaySeconds?: number } | null)
    : null;
  const enabled = commentConfig?.autoCommentCaptionAfterPublish ?? (process.env.AUTO_COMMENT_CAPTION_AFTER_PUBLISH !== "false");
  const delaySeconds = Math.max(0, (commentConfig?.autoCommentDelaySeconds ?? Number(process.env.AUTO_COMMENT_DELAY_SECONDS ?? "5")) || 0);
  const jobId = input.job._id;
  const baseMeta = {
    targetPageId: input.pageId,
    pageName: input.pageName,
    facebookPostId: input.facebookPostId,
    commentSource: "finalCaption"
  };
  const log = (level: "info" | "success" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    logAction({
      userId: input.job.userId,
      type: "queue",
      level,
      message,
      relatedJobId: jobId,
      relatedPostId: input.postId,
      metadata: { ...baseMeta, ...extra }
    }).catch(() => undefined);

  try {
    if (!enabled) {
      await Job.findByIdAndUpdate(jobId, { autoCommentStatus: "skipped" });
      await log("info", "AUTO_COMMENT_SKIPPED_DISABLED");
      return;
    }
    const existing = (await Job.findById(jobId).select("facebookCommentId").lean()) as { facebookCommentId?: string } | null;
    if (existing?.facebookCommentId) {
      await log("info", "AUTO_COMMENT_SKIPPED_ALREADY_EXISTS", { facebookCommentId: existing.facebookCommentId });
      return;
    }
    const finalCaption = (input.finalCaption ?? "").trim();
    if (!input.facebookPostId || !finalCaption) {
      await Job.findByIdAndUpdate(jobId, {
        autoCommentStatus: "skipped",
        autoCommentError: !input.facebookPostId ? "missing facebookPostId" : "empty final caption"
      });
      await log("warn", "AUTO_COMMENT_SKIPPED_DISABLED", { reason: !input.facebookPostId ? "missing_post_id" : "empty_caption" });
      return;
    }
    await Job.findByIdAndUpdate(jobId, { autoCommentStatus: "pending", commentSource: "finalCaption" });
    await log("info", "AUTO_COMMENT_CAPTION_LOADED", { captionLength: finalCaption.length, captionPreview: finalCaption.slice(0, 200) });
    await log("info", "AUTO_COMMENT_POST_ID_MATCHED");
    if (delaySeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
    await log("info", "AUTO_COMMENT_STARTED");

    let lastError: unknown = null;
    const maxAttempts = 3; // 1 initial attempt + 2 retries
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await commentOnFacebookPost({
          postId: input.facebookPostId,
          pageAccessToken: input.pageAccessToken,
          message: finalCaption
        });
        await Job.findByIdAndUpdate(jobId, {
          facebookCommentId: result.id,
          autoCommentStatus: "success",
          autoCommentError: null,
          autoCommentedAt: new Date(),
          commentSource: "finalCaption"
        });
        await log("success", "AUTO_COMMENT_CREATED", { facebookCommentId: result.id, attempt });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await log("warn", "AUTO_COMMENT_RETRY", { attempt, error: error instanceof Error ? error.message : String(error) });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    await Job.findByIdAndUpdate(jobId, { autoCommentStatus: "failed", autoCommentError: errorMessage });
    await log("error", "AUTO_COMMENT_FAILED", { error: errorMessage });
  } catch (error) {
    // Auto comment must never fail the publish workflow.
    try {
      await Job.findByIdAndUpdate(jobId, {
        autoCommentStatus: "failed",
        autoCommentError: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // ignore secondary failure
    }
    await log("error", "AUTO_COMMENT_FAILED", { error: error instanceof Error ? error.message : String(error) });
  }
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

    if (!(await updateBoundShopeeAutoPostRunState(job)) && hasBoundAutoPostConfig(job)) {
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
      duplicateWindowHours,
      targetPageId: job.targetPageId
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
      if (!(await updateBoundShopeeAutoPostRunState(job)) && hasBoundAutoPostConfig(job)) {
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

  await logAction({
    userId: job.userId,
    type: "queue",
    level: "info",
    message: "VALIDATE_PAGE_TOKEN: Facebook page token found",
    relatedJobId: job._id,
    relatedPostId: job.postId,
    relatedScheduleId: job.scheduleId,
    metadata: {
      ...getAutoPostLogFlags(job),
      targetPageId: page.pageId,
      pageName: page.name,
      autoPostConfigId: job.payload?.autoPostConfigId,
      autoPostAiConfigId: job.payload?.autoPostAiConfigId,
      workflowRunId: job.payload?.workflowRunId,
      correlationId: job.correlationId
    }
  });

  let pageProfileImage: { bytes: ArrayBuffer; mimeType: string } | null = null;
  const watermarkSettings = hasBoundAutoPostConfig(job) ? await getWatermarkSettings(job) : null;
  if (hasBoundAutoPostConfig(job) && watermarkSettings?.enabled && watermarkSettings.source === "page_profile") {
    try {
      const pageLogo = await getPageLogoForFacebookPage({
        userId: job.userId,
        pageId: page.pageId,
        connection
      });
      pageProfileImage = pageLogo.image;
      if (!pageLogo.image) {
        await logAction({
          userId: job.userId,
          type: "queue",
          level: "warn",
          message: "Page logo unavailable, publishing without watermark logo",
          relatedJobId: job._id,
          relatedPostId: job.postId,
          relatedScheduleId: job.scheduleId,
          metadata: {
            ...getAutoPostLogFlags(job),
            targetPageId: page.pageId,
            correlationId: job.correlationId,
            watermarkEnabled: watermarkSettings?.enabled ?? true,
            watermarkSource: watermarkSettings?.source ?? "page_profile",
            pageLogoSource: pageLogo.source,
            cachedProfilePictureUrl: pageLogo.profilePictureUrl
          }
        });
      }
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
          watermarkEnabled: watermarkSettings?.enabled ?? true,
          watermarkSource: watermarkSettings?.source ?? "page_profile",
          error: error instanceof Error ? error.message : "unknown"
        }
      });
    }
  }

  const variants = post.variants?.length ? post.variants : [{ caption: post.content, hashtags: post.hashtags }];
  const chosenVariant = post.randomizeCaption ? randomItem(variants) : variants[0];
  const rawMessage = buildPublishMessage(chosenVariant.caption, chosenVariant.hashtags);
  const message = isShopeeAffiliateJob(job)
    ? normalizeShopeePublishHashtags(
        normalizeShopeeCaptionLinkLine(
          normalizeTextEncoding(rawMessage),
          typeof job.payload?.affiliateLink === "string" ? job.payload.affiliateLink : undefined
        )
      )
    : rawMessage;
  const repairedImageRefs = await ensureShopeeAffiliateImageRefs(job, post);
  const imageRefs = post.randomizeImages && repairedImageRefs.length > 0 ? [randomItem(repairedImageRefs)] : repairedImageRefs;
  await logAction({
    userId: job.userId,
    type: "queue",
    level: "info",
    message: "PAGE_UPLOAD_IMAGES_STARTED: Preparing images for Facebook upload",
    relatedJobId: job._id,
    relatedPostId: job.postId,
    relatedScheduleId: job.scheduleId,
    metadata: {
      ...getAutoPostLogFlags(job),
      targetPageId: page.pageId,
      pageName: page.name,
      imageCount: imageRefs.length,
      autoPostConfigId: job.payload?.autoPostConfigId,
      workflowRunId: job.payload?.workflowRunId,
      correlationId: job.correlationId
    }
  });
  const images = await decorateAutoPostImages(
    await resolveImages(job.userId, imageRefs),
    job.payload?.automationMode,
    pageProfileImage
  );

  if (isShopeeAffiliateJob(job)) {
    await validateShopeeAffiliatePublishPayload({
      job,
      message,
      imageCount: images.length
    });
    await logAction({
      userId: job.userId,
      type: "queue",
      level: "success",
      message: "[UTF-8 Validation Passed] Shopee caption is safe for Facebook publish",
      relatedJobId: job._id,
      relatedPostId: job.postId,
      relatedScheduleId: job.scheduleId,
      metadata: {
        ...getAutoPostLogFlags(job),
        targetPageId: page.pageId,
        pageName: page.name,
        correlationId: job.correlationId
      }
    });
  }

  const facebookAttachmentLink = isShopeeAffiliateJob(job)
    ? resolveShopeeFacebookAttachmentLink(job, message)
    : undefined;

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

  if (isShopeeAffiliateJob(job)) {
    console.info("[FB_LINK]", {
      jobId: String(job._id),
      pageId: page.pageId,
      pageName: page.name,
      hasAttachmentLink: Boolean(facebookAttachmentLink),
      linkHost: facebookAttachmentLink ? new URL(facebookAttachmentLink).hostname : null
    });
    await logAction({
      userId: job.userId,
      type: "queue",
      level: facebookAttachmentLink ? "info" : "warn",
      message: facebookAttachmentLink
        ? "[FB_LINK] Shopee short link will be sent as Facebook link attachment"
        : "[FB_LINK] Shopee short link attachment missing before Facebook publish",
      relatedJobId: job._id,
      relatedPostId: job.postId,
      relatedScheduleId: job.scheduleId,
      metadata: {
        ...getAutoPostLogFlags(job),
        targetPageId: page.pageId,
        pageName: page.name,
        hasAttachmentLink: Boolean(facebookAttachmentLink),
        linkHost: facebookAttachmentLink ? new URL(facebookAttachmentLink).hostname : null,
        workflowRunId: job.payload?.workflowRunId,
        correlationId: job.correlationId
      }
    });
  }

  await logAction({
    userId: job.userId,
    type: "queue",
    level: "info",
    message: "[Facebook Publish Started] PAGE_PUBLISH_STARTED: Publishing Shopee post to Facebook page",
    relatedJobId: job._id,
    relatedPostId: job.postId,
    relatedScheduleId: job.scheduleId,
    metadata: {
      ...getAutoPostLogFlags(job),
      targetPageId: page.pageId,
      pageName: page.name,
      imageCount: images.length,
      autoPostConfigId: job.payload?.autoPostConfigId,
      workflowRunId: job.payload?.workflowRunId,
      correlationId: job.correlationId
    }
  });

  const publishResult = await publishPostToFacebook({
    pageId: page.pageId,
    pageAccessToken: page.pageAccessToken,
    message,
    link: facebookAttachmentLink,
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

  await updateShopeeQueueStatus(job, "published", { publishResult });

  await autoCommentFinalCaptionUnderPost({
    job,
    pageId: page.pageId,
    pageAccessToken: page.pageAccessToken,
    pageName: page.name,
    postId: String(post._id),
    facebookPostId: typeof publishResult?.id === "string" ? publishResult.id : undefined,
    finalCaption: message
  });

  await logAction({
    userId: job.userId,
    type: "post",
    level: "success",
    message: `[Facebook Publish Success] PAGE_PUBLISH_SUCCESS: Shopee post published to ${page.name}`,
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

  if (!(await updateBoundShopeeAutoPostRunState(job)) && hasBoundAutoPostConfig(job)) {
    await updateBoundAutoPostState(
      job,
      {
        autoPostStatus: "success",
        jobStatus: "posted",
        lastStatus: "posted",
        retryCount: 0,
        lastError: null,
        lastPostId: post._id,
        lastRunAt: new Date()
      },
      {
        autoPostStatus: "success",
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

        if (!shouldRetry) {
          await updateShopeeQueueStatus(job, "failed", {
            failureReason: failure.failureReason,
            errorCode: failure.errorCode
          });
        }
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
            ? `PAGE_PUBLISH_FAILED: post ${job.postId} failed and will retry (${attempts}/${job.maxAttempts}): ${failure.failureReason}`
            : `PAGE_PUBLISH_FAILED: post ${job.postId} failed after ${attempts} attempts: ${failure.failureReason}`,
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

        if (job.type !== "comment-reply" && !(await updateBoundShopeeAutoPostRunState(job)) && hasBoundAutoPostConfig(job)) {
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
