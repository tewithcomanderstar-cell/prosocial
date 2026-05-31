import crypto from "crypto";
import { createAutoPostRecords } from "@/lib/services/automation-records";
import { extractExactTextFromImage, extractPrimaryCreativeTextFromImage, generateFacebookContent } from "@/lib/services/ai";
import { fetchDriveImageBinary, fetchImagesFromFolder } from "@/lib/services/google-drive";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { enqueuePostJobsForPost, processQueuedJobs } from "@/lib/services/queue";
import {
  buildShopeePostPackage,
  ensureShopeeAffiliateConfigured,
  getShopeeSubIdCacheKey,
  logShopeeAutomationEvent,
  recordShopeeQueueItem,
  resolveShopeeSubIds,
  selectShopeeProductsForPages,
  ShopeeCaptionStyle,
  ShopeeSubIdFields,
  ShopeeSourceTag
} from "@/lib/services/shopee-affiliate";
import { randomItem } from "@/lib/utils";
import { ensureStorageBeforeAutoPost, mapStorageQuotaMessage } from "@/lib/services/storage-cleanup";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { Job } from "@/models/Job";
import { Post } from "@/models/Post";

type AutoPostStatus = "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
type JobStatus = "pending" | "processing" | "posted" | "failed";

type LeanAutoPostConfig = {
  _id: string;
  userId: string;
  enabled: boolean;
  contentSource?: "shopee-affiliate" | "google-drive";
  folderId: string;
  folderName?: string;
  shopeeSourceTag?: ShopeeSourceTag;
  shopeeKeyword?: string;
  shopeeCategory?: string;
  shopeeCaptionStyle?: ShopeeCaptionStyle;
  shopeeTrackingId?: string;
  shopeeSubId?: string;
  shopeeSubId1?: string;
  shopeeSubId2?: string;
  shopeeSubId3?: string;
  shopeeSubId4?: string;
  shopeeSubId5?: string;
  shopeeBlockedCategories?: string[];
  shopeeCategoryPriority?: string[];
  shopeeMinPrice?: number;
  shopeeMaxPrice?: number;
  shopeeMinRating?: number;
  shopeeMinSales?: number;
  shopeeMinDiscountPercent?: number;
  approvalMode?: boolean;
  targetPageIds: string[];
  intervalMinutes: number;
  minRandomDelayMinutes?: number;
  maxRandomDelayMinutes?: number;
  maxPostsPerDay?: number;
  maxPostsPerPagePerDay?: number;
  captionStrategy: "manual" | "ai" | "hybrid";
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
};

type LeanDriveConnection = {
  accessToken: string;
};

type DriveImage = {
  id: string;
  name: string;
  mimeType?: string;
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

type ShopeeSelectedProduct = Awaited<ReturnType<typeof selectShopeeProductsForPages>>[number];
type ShopeePostPackageResult = Awaited<ReturnType<typeof buildShopeePostPackage>>;
type AutoPostErrorClassification = "retry_with_next_product" | "retry_same_product" | "job_failed";
type FacebookPageSubIds = ShopeeSubIdFields & { pageId: string };

const AUTO_POST_BATCH_PAGE_SPACING_MINUTES = Number(process.env.AUTO_POST_PAGE_SPACING_MINUTES ?? "10");
const AUTO_POST_JOB_TIMEOUT_MS = Number(process.env.AUTO_POST_JOB_TIMEOUT_MS ?? "300000");
const AUTO_POST_MAX_PRODUCT_ATTEMPTS = Math.max(1, Number(process.env.AUTO_POST_MAX_PRODUCT_ATTEMPTS ?? "5"));
const AUTO_POST_SAME_PRODUCT_RETRIES = Math.max(1, Number(process.env.AUTO_POST_SAME_PRODUCT_RETRIES ?? "2"));
const SHOPEE_BATCH_PRODUCT_MODE = process.env.SHOPEE_BATCH_PRODUCT_MODE === "per_page" ? "per_page" : "single";
const OPEN_AUTO_POST_JOB_STATUSES = ["queued", "processing", "retrying", "rate_limited"] as const;
const BANGKOK_UTC_OFFSET_HOURS = 7;

function getConfigShopeeSubIds(config: LeanAutoPostConfig): ShopeeSubIdFields {
  return {
    subId: config.shopeeSubId,
    subId1: config.shopeeSubId1,
    subId2: config.shopeeSubId2,
    subId3: config.shopeeSubId3,
    subId4: config.shopeeSubId4,
    subId5: config.shopeeSubId5
  };
}

function getPageSubIdsByPageId(connection: unknown) {
  const map = new Map<string, ShopeeSubIdFields>();
  const pages = Array.isArray((connection as { pages?: unknown[] } | null)?.pages)
    ? ((connection as { pages?: unknown[] }).pages ?? [])
    : [];

  for (const page of pages) {
    const pageRecord = page as Partial<FacebookPageSubIds> & { id?: string; externalPageId?: string };
    const pageId = String(pageRecord.pageId ?? pageRecord.id ?? pageRecord.externalPageId ?? "").trim();
    if (!pageId) continue;
    map.set(pageId, {
      subId: pageRecord.subId,
      subId1: pageRecord.subId1,
      subId2: pageRecord.subId2,
      subId3: pageRecord.subId3,
      subId4: pageRecord.subId4,
      subId5: pageRecord.subId5
    });
  }

  return map;
}

function resolveSubIdsForPage(config: LeanAutoPostConfig, pageSubIdsByPageId: Map<string, ShopeeSubIdFields>, pageId: string) {
  return resolveShopeeSubIds({
    pageSubIds: pageSubIdsByPageId.get(pageId),
    configSubIds: getConfigShopeeSubIds(config)
  });
}

function getShopeePackageCacheKey(input: {
  productId: string;
  captionStyle: ShopeeCaptionStyle;
  trackingId: string;
  subIds: ShopeeSubIdFields;
}) {
  return [
    input.productId,
    input.captionStyle,
    input.trackingId || "default",
    getShopeeSubIdCacheKey(input.subIds)
  ].join(":");
}

const AUTO_POST_QUOTE_EXPANSION_PROMPT = `คุณคือผู้เชี่ยวชาญด้านการเขียนคอนเทนต์โซเชียลมีเดีย (Facebook/IG) ที่เน้นเพิ่ม Time Spend, Engagement (Like/Comment/Share) และความรู้สึกของผู้อ่าน

หน้าที่ของคุณคือ:
แปลง “คำคมสั้น” ให้กลายเป็น “โพสต์คุณภาพ” ที่ทำให้คนหยุดอ่าน อ่านต่อ และอยากมีส่วนร่วม

อินพุต:
- คำคมสั้น 1 ประโยค

เอาต์พุต:
เขียนแคปชันใหม่ โดยต้องมีโครงสร้างดังนี้:

1. Hook เปิด (1–2 บรรทัด)
- ต้องดึงอารมณ์/ความสงสัย
- ทำให้คนอยากอ่านต่อทันที

2. ขยายความ (2–4 บรรทัด)
- แปลงคำคมให้มีมุมคิดลึกขึ้น
- ใช้ภาษาธรรมชาติ อ่านง่าย ไม่ทางการ
- อาจมีการเปรียบเทียบหรือ insight

3. เชื่อมกับชีวิตจริง (1–3 บรรทัด)
- ทำให้ผู้อ่านรู้สึกว่า “เกี่ยวกับตัวเอง”
- ใช้สถานการณ์ที่คนทั่วไปเจอ

4. คำถามปลายเปิด (1–2 บรรทัด)
- กระตุ้นให้คอมเมนต์
- เช่น “คุณล่ะ…กำลังเลือกอะไรอยู่?”

ข้อกำหนดเพิ่มเติม:
- ใช้โทนภาษาธรรมชาติ นุ่ม ๆ เป็นกันเอง
- หลีกเลี่ยงภาษาทางการหรือแข็งเกินไป
- ไม่ยาวเกิน 8–12 บรรทัด
- ไม่ใช้ hashtag
- ต้องมีอารมณ์และชวนคิด

ให้ใช้ข้อความที่ดึงมาจากภาพเป็นแกนกลางของโพสต์เท่านั้น และแปลงให้เป็นโพสต์พร้อมใช้จริง`;

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

function uniquePageIds(pageIds: string[] = []) {
  return Array.from(new Set(pageIds.map((pageId) => pageId.trim()).filter(Boolean)));
}

function getBatchCompletionTime(batchStartAt: Date, pageCount: number) {
  const spacingMs = Math.max(0, AUTO_POST_BATCH_PAGE_SPACING_MINUTES) * 60 * 1000;
  return new Date(batchStartAt.getTime() + Math.max(0, pageCount - 1) * spacingMs);
}

function ensureNextRunAfterBatch(nextRunAt: Date, batchStartAt: Date, pageCount: number, windowStart?: string | null, windowEnd?: string | null) {
  const minimumNextRunAt = new Date(getBatchCompletionTime(batchStartAt, pageCount).getTime() + 60 * 1000);
  const candidate = nextRunAt > minimumNextRunAt ? nextRunAt : minimumNextRunAt;
  return isWithinPostingWindow(candidate, windowStart, windowEnd)
    ? candidate
    : getNextWindowStart(candidate, windowStart, windowEnd);
}

function normalizeCycleUsedImageIds(images: DriveImage[], usedImageIds: string[] = []) {
  if (!usedImageIds.length) {
    return [];
  }

  const validIds = new Set(images.map((image) => image.id));
  return usedImageIds.filter((imageId) => validIds.has(imageId));
}

function pickImagesForCycle(
  images: DriveImage[],
  pageCount: number,
  dailyUsedImageIds: string[] = [],
  usedImageIds: string[] = []
) {
  if (!images.length || pageCount <= 0) {
    return {
      chosenImages: [] as DriveImage[],
      nextUsedImageIds: normalizeCycleUsedImageIds(images, usedImageIds)
    };
  }

  const normalizedUsedImageIds = normalizeCycleUsedImageIds(images, usedImageIds);
  const dailyBlockedIds = new Set(dailyUsedImageIds);
  const cycleBlockedIds = new Set(normalizedUsedImageIds);

  let prioritizedPool = randomizeOrder(
    images.filter((image) => !dailyBlockedIds.has(image.id) && !cycleBlockedIds.has(image.id))
  );

  let nextUsedImageIds = normalizedUsedImageIds;

  if (prioritizedPool.length < pageCount) {
    prioritizedPool = randomizeOrder(images.filter((image) => !dailyBlockedIds.has(image.id)));
    nextUsedImageIds = [];
  }

  if (prioritizedPool.length < pageCount) {
    throw new Error(
      `Not enough unused images left for today. Available: ${prioritizedPool.length}, required: ${pageCount}. Add more images or wait until tomorrow.`
    );
  }

  const chosenImages = prioritizedPool.slice(0, pageCount);
  return {
    chosenImages,
    nextUsedImageIds: [...nextUsedImageIds, ...chosenImages.map((image) => image.id)]
  };
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
  usedImageIds: string[] = []
) {
  if (!images.length || pageCount <= 0) {
    return {
      chosenImages: [] as DriveImage[],
      nextDailyUsedImageIds: persistedDayKey === currentDayKey ? dailyUsedImageIds : [],
      activeDayKey: currentDayKey,
      nextUsedImageIds: normalizeCycleUsedImageIds(images, usedImageIds)
    };
  }

  const activeDayKey = persistedDayKey === currentDayKey ? currentDayKey : currentDayKey;
  const activeDailyUsedImageIds = persistedDayKey === currentDayKey ? dailyUsedImageIds : [];
  const { chosenImages, nextUsedImageIds } = pickImagesForCycle(
    images,
    pageCount,
    activeDailyUsedImageIds,
    usedImageIds
  );

  return {
    chosenImages,
    nextDailyUsedImageIds: [...activeDailyUsedImageIds, ...chosenImages.map((image) => image.id)],
    activeDayKey,
    nextUsedImageIds
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
    enabled: boolean;
    lastStatus: "pending" | "posted" | "failed" | "paused";
    lastWorkflowId: unknown;
    lastWorkflowRunId: unknown;
    lastContentItemId: unknown;
  }>
) {
  await AutoPostConfig.findByIdAndUpdate(configId, updates);
}

async function countSuccessfulAutoPostsToday(userId: string, configId: string, pageId?: string) {
  const parts = getBangkokDateParts(new Date());
  const startOfDay = toBangkokDate(parts, 0);

  const query: Record<string, unknown> = {
    userId,
    status: "success",
    createdAt: { $gte: startOfDay },
    "payload.autoPostConfigId": configId
  };

  if (pageId) {
    query.targetPageId = pageId;
  }

  return Job.countDocuments(query);
}

export async function countOpenShopeePageJobsForConfig(configId: string, userId?: string) {
  const query: Record<string, unknown> = {
    type: "post",
    status: { $in: [...OPEN_AUTO_POST_JOB_STATUSES] },
    "payload.autoSource": "shopee-affiliate",
    "payload.autoPostConfigId": configId
  };

  if (userId) {
    query.userId = userId;
  }

  return Job.countDocuments(query);
}

function stripFileExtension(value: string) {
  return value.replace(/\.[a-z0-9]+$/i, "").trim();
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

function hashValue(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeAutoPostError(error: unknown, fallback = "Auto Post failed") {
  const storageMessage = mapStorageQuotaMessage(error);
  if (storageMessage) {
    return storageMessage;
  }

  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const normalized = message.toLowerCase();
  if (normalized.includes("signal is aborted") || normalized.includes("aborterror") || normalized.includes("aborted")) {
    return "Auto Post job was aborted or timed out. The job has been stopped safely; please retry after deployment finishes.";
  }
  return message || fallback;
}

function getAutoPostErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
}

export function classifyAutoPostError(error: unknown): AutoPostErrorClassification {
  const message = getAutoPostErrorMessage(error).toLowerCase();

  if (
    message.includes("missing env") ||
    message.includes("no selected facebook") ||
    message.includes("no facebook pages") ||
    message.includes("facebook connection") ||
    message.includes("invalid facebook token") ||
    message.includes("database unavailable") ||
    message.includes("storage quota") ||
    message.includes("affiliate setup") ||
    message.includes("affiliate config")
  ) {
    return "job_failed";
  }

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("temporar") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("econn") ||
    message.includes("blob")
  ) {
    return "retry_same_product";
  }

  if (
    message.includes("safety system") ||
    message.includes("content policy") ||
    message.includes("moderation rejected") ||
    message.includes("request was rejected") ||
    message.includes("safety rejected") ||
    message.includes("image generation rejected") ||
    message.includes("product image invalid") ||
    message.includes("unsafe image") ||
    message.includes("blocked content") ||
    message.includes("product image is missing") ||
    message.includes("reference_image_unavailable") ||
    message.includes("reference image") ||
    message.includes("generated image validation failed") ||
    message.includes("returned the original shopee product image") ||
    message.includes("returned duplicate ugc images") ||
    message.includes("shopee ugc image generation failed")
  ) {
    return "retry_with_next_product";
  }

  return "job_failed";
}

async function logShopeeStep(input: {
  config: LeanAutoPostConfig;
  step: string;
  status: "started" | "success" | "failed" | "skipped";
  message: string;
  pageId?: string;
  productId?: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
}) {
  await logShopeeAutomationEvent({
    userId: input.config.userId,
    level: input.status === "failed" ? "error" : input.status === "skipped" ? "warn" : "info",
    message: `${input.step}: ${input.message}`,
    pageId: input.pageId,
    productId: input.productId,
    metadata: {
      autoPostConfigId: input.config._id,
      step: input.step,
      status: input.status,
      ...(input.metadata ?? {}),
      ...(input.error
        ? {
            error: normalizeAutoPostError(input.error),
            stack: input.error instanceof Error ? input.error.stack?.split("\n").slice(0, 4).join("\n") : undefined
          }
        : {})
    }
  });
}

async function createFailedShopeePageJob(input: {
  config: LeanAutoPostConfig;
  pageId: string;
  pageIndex: number;
  selectedPagesCount: number;
  workflowId: string;
  workflowRunId: string;
  contentItemId: string;
  productId?: string;
  productName?: string;
  scheduledAt: Date;
  error: unknown;
  errorCode: string;
  failedStep: string;
}) {
  const message = normalizeAutoPostError(input.error, "Shopee page preparation failed");
  const fingerprint = hashValue({
    source: "shopee-affiliate",
    pageId: input.pageId,
    productId: input.productId ?? "no-product",
    workflowRunId: input.workflowRunId,
    failedStep: input.failedStep
  });

  await Job.create({
    userId: input.config.userId,
    type: "post",
    targetPageId: input.pageId,
    payload: {
      autoPostConfigId: input.config._id,
      autoSource: "shopee-affiliate",
      shopeeProductId: input.productId,
      shopeeProductName: input.productName,
      selectedPagesCount: input.selectedPagesCount,
      pageIndex: input.pageIndex,
      scheduledDelayMinutes: Math.max(0, Math.round((input.scheduledAt.getTime() - Date.now()) / 60000)),
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      contentItemId: input.contentItemId,
      failedStep: input.failedStep
    },
    fingerprint,
    dedupeKey: `${input.workflowRunId}:${input.pageId}:failed:${input.failedStep}`,
    status: "failed",
    attempts: 1,
    maxAttempts: 1,
    nextRunAt: input.scheduledAt,
    lastAttemptAt: new Date(),
    completedAt: new Date(),
    lastError: message,
    failureReason: message,
    errorCode: input.errorCode,
    errorDetails: {
      failedStep: input.failedStep,
      pageId: input.pageId,
      productId: input.productId,
      originalMessage: input.error instanceof Error ? input.error.message : String(input.error ?? message)
    },
    result: {
      status: "failed",
      failedStep: input.failedStep,
      message
    }
  });

  await logShopeeStep({
    config: input.config,
    step: input.failedStep,
    status: "failed",
    message,
    pageId: input.pageId,
    productId: input.productId,
    error: input.error,
    metadata: {
      errorCode: input.errorCode,
      pageIndex: input.pageIndex,
      selectedPagesCount: input.selectedPagesCount,
      workflowRunId: input.workflowRunId
    }
  });
}

async function prepareSingleShopeePackageWithProductAttempts(input: {
  config: LeanAutoPostConfig;
  eligiblePageIds: string[];
  pageSubIdsByPageId: Map<string, ShopeeSubIdFields>;
  initialSelectedProducts: ShopeeSelectedProduct[];
  records: {
    workflowId: string;
    workflowRunId: string;
    contentItemId: string;
  };
  batchStartAt: Date;
  pageSpacingMinutes: number;
}) {
  const skippedProductIds = new Set<string>();
  const skippedProducts: Array<{
    productId: string;
    shopId?: string;
    productName: string;
    reason: string;
    classification: AutoPostErrorClassification;
  }> = [];

  for (let attempt = 1; attempt <= AUTO_POST_MAX_PRODUCT_ATTEMPTS; attempt += 1) {
    const selectedProducts =
      attempt === 1 && input.initialSelectedProducts.length
        ? input.initialSelectedProducts
        : await selectShopeeProductsForPages({
            userId: input.config.userId,
            pageIds: input.eligiblePageIds,
            sourceTag: input.config.shopeeSourceTag ?? "trending",
            keyword: input.config.shopeeKeyword,
            category: input.config.shopeeCategory,
            categoryPriority: input.config.shopeeCategoryPriority ?? [],
            blockedCategories: input.config.shopeeBlockedCategories ?? [],
            minPrice: input.config.shopeeMinPrice ?? 0,
            maxPrice: input.config.shopeeMaxPrice ?? 0,
            minRating: input.config.shopeeMinRating ?? 0,
            minSales: input.config.shopeeMinSales ?? 0,
            minDiscountPercent: input.config.shopeeMinDiscountPercent ?? 0,
            excludedProductIds: Array.from(skippedProductIds)
          });

    const selected = selectedProducts[0];
    if (!selected) break;

    const productId = String(selected.product.productId);
    const pageIndex = Math.max(0, input.eligiblePageIds.indexOf(selected.pageId));
    const startAt = new Date(input.batchStartAt.getTime() + Math.max(pageIndex, 0) * input.pageSpacingMinutes * 60 * 1000);
    const trackingId = input.config.shopeeTrackingId?.trim() || `page-${selected.pageId}`;
    const subIds = resolveSubIdsForPage(input.config, input.pageSubIdsByPageId, selected.pageId);
    const packageCacheKey = getShopeePackageCacheKey({
      productId,
      captionStyle: input.config.shopeeCaptionStyle ?? "soft_sell",
      trackingId,
      subIds
    });

    await logShopeeStep({
      config: input.config,
      step: "PRODUCT_ATTEMPT_STARTED",
      status: "started",
      message: `Trying Shopee product attempt ${attempt}/${AUTO_POST_MAX_PRODUCT_ATTEMPTS}`,
      pageId: selected.pageId,
      productId,
      metadata: {
        attempt,
        maxAttempts: AUTO_POST_MAX_PRODUCT_ATTEMPTS,
        skippedProductsCount: skippedProducts.length,
        productName: selected.product.productName,
        score: selected.score.productScore,
        reason: selected.score.reason,
        subId: subIds.subId,
        subId1: subIds.subId1,
        subId2: subIds.subId2,
        subId3: subIds.subId3,
        subId4: subIds.subId4,
        subId5: subIds.subId5,
        workflowRunId: input.records.workflowRunId
      }
    });

    await updateAutoPostState(input.config._id, {
      autoPostStatus: attempt > 1 ? "retrying" : "running",
      jobStatus: "pending",
      lastStatus: "pending",
      lastError: attempt > 1 ? `Trying next Shopee product (${attempt}/${AUTO_POST_MAX_PRODUCT_ATTEMPTS})` : null
    });

    let lastError: unknown = null;
    for (let sameProductAttempt = 1; sameProductAttempt <= AUTO_POST_SAME_PRODUCT_RETRIES; sameProductAttempt += 1) {
      try {
        const packageResult = await buildShopeePostPackage({
          userId: input.config.userId,
          pageId: selected.pageId,
          product: selected.product,
          scheduledAt: startAt,
          captionStyle: input.config.shopeeCaptionStyle ?? "soft_sell",
          trackingId,
          subIds,
          jobId: input.records.workflowRunId
        });

        await logShopeeStep({
          config: input.config,
          step: "PRODUCT_ATTEMPT_SUCCESS",
          status: "success",
          message: `Shopee product attempt ${attempt}/${AUTO_POST_MAX_PRODUCT_ATTEMPTS} is ready for all selected pages`,
          pageId: selected.pageId,
          productId,
          metadata: {
            attempt,
            maxAttempts: AUTO_POST_MAX_PRODUCT_ATTEMPTS,
            sameProductAttempt,
            skippedProductsCount: skippedProducts.length,
            imageCount: packageResult.generatedImageUrls.length,
            hasShortLink: Boolean(packageResult.shortAffiliateLink),
            trackingId,
            subId: subIds.subId,
            workflowRunId: input.records.workflowRunId
          }
        });

        return {
          selectedProductsForQueue: input.eligiblePageIds.map((pageId) => ({ ...selected, pageId })),
          packageResult,
          packageCacheKey,
          skippedProducts
        };
      } catch (error) {
        lastError = error;
        const classification = classifyAutoPostError(error);

        await logShopeeStep({
          config: input.config,
          step: "PRODUCT_ATTEMPT_FAILED",
          status: "failed",
          message: `Shopee product attempt ${attempt}/${AUTO_POST_MAX_PRODUCT_ATTEMPTS} failed as ${classification}`,
          pageId: selected.pageId,
          productId,
          error,
          metadata: {
            attempt,
            maxAttempts: AUTO_POST_MAX_PRODUCT_ATTEMPTS,
            sameProductAttempt,
            sameProductRetries: AUTO_POST_SAME_PRODUCT_RETRIES,
            classification,
            productName: selected.product.productName,
            workflowRunId: input.records.workflowRunId
          }
        });

        if (classification === "retry_same_product" && sameProductAttempt < AUTO_POST_SAME_PRODUCT_RETRIES) {
          continue;
        }

        if (classification === "retry_with_next_product") {
          skippedProductIds.add(productId);
          skippedProducts.push({
            productId,
            shopId: selected.product.shopId,
            productName: selected.product.productName,
            reason: normalizeAutoPostError(error, "Product skipped"),
            classification
          });

          await logShopeeStep({
            config: input.config,
            step: "PRODUCT_SKIPPED_SAFETY_REJECTED",
            status: "skipped",
            message: "Skipped this Shopee product and will try the next product",
            pageId: selected.pageId,
            productId,
            error,
            metadata: {
              attempt,
              maxAttempts: AUTO_POST_MAX_PRODUCT_ATTEMPTS,
              reason: "safety_rejected_or_image_failed",
              skippedProductsCount: skippedProducts.length,
              productName: selected.product.productName,
              workflowRunId: input.records.workflowRunId
            }
          });

          await logShopeeStep({
            config: input.config,
            step: "RETRYING_WITH_NEXT_PRODUCT",
            status: "started",
            message: `Trying next Shopee product after ${selected.product.productName} failed`,
            metadata: {
              attempt,
              nextAttempt: attempt + 1,
              maxAttempts: AUTO_POST_MAX_PRODUCT_ATTEMPTS,
              skippedProductsCount: skippedProducts.length,
              workflowRunId: input.records.workflowRunId
            }
          });

          await updateAutoPostState(input.config._id, {
            autoPostStatus: "retrying",
            jobStatus: "pending",
            lastStatus: "pending",
            lastError: `Product skipped: ${normalizeAutoPostError(error, "safety rejected")}`
          });

          break;
        }

        throw error;
      }
    }

    if (lastError && classifyAutoPostError(lastError) !== "retry_with_next_product") {
      throw lastError;
    }
  }

  const message = `No eligible product could be posted after ${AUTO_POST_MAX_PRODUCT_ATTEMPTS} attempts`;
  await logShopeeStep({
    config: input.config,
    step: "MAX_PRODUCT_ATTEMPTS_REACHED",
    status: "failed",
    message,
    error: new Error(message),
    metadata: {
      maxAttempts: AUTO_POST_MAX_PRODUCT_ATTEMPTS,
      skippedProducts,
      workflowRunId: input.records.workflowRunId
    }
  });

  for (let index = 0; index < input.eligiblePageIds.length; index += 1) {
    const pageId = input.eligiblePageIds[index];
    const startAt = new Date(input.batchStartAt.getTime() + index * input.pageSpacingMinutes * 60 * 1000);
    await createFailedShopeePageJob({
      config: input.config,
      pageId,
      pageIndex: index + 1,
      selectedPagesCount: input.eligiblePageIds.length,
      workflowId: input.records.workflowId,
      workflowRunId: input.records.workflowRunId,
      contentItemId: input.records.contentItemId,
      scheduledAt: startAt,
      error: new Error(message),
      errorCode: "max_product_attempts_reached",
      failedStep: "MAX_PRODUCT_ATTEMPTS_REACHED"
    });
  }

  await updateAutoPostState(input.config._id, {
    autoPostStatus: "failed",
    jobStatus: "failed",
    lastStatus: "failed",
    lastError: message
  });

  throw new Error(message);
}

async function queueShopeeAutoPostsForConfig(
  config: LeanAutoPostConfig,
  options: QueueAutoPostsOptions,
  triggeredAt: Date,
  nextRunAt: Date
): Promise<QueueAutoPostsResult> {
  await logShopeeStep({
    config,
    step: "START_JOB",
    status: "started",
    message: options.source === "manual-start" ? "Manual Shopee Auto Post started" : "Scheduled Shopee Auto Post started",
    metadata: { source: options.source, immediate: options.immediate }
  });

  let eligiblePageIds = uniquePageIds(config.targetPageIds);
  if (!eligiblePageIds.length) {
    await logShopeeStep({
      config,
      step: "VALIDATE_FACEBOOK_PAGES",
      status: "failed",
      message: "No selected Facebook page"
    });
    throw new Error("No Facebook pages selected for Shopee Affiliate Auto Post");
  }

  const openPageJobs = await countOpenShopeePageJobsForConfig(config._id, config.userId);
  if (openPageJobs > 0) {
    const delayedNextRunAt = getNextAutoRun(
      config.intervalMinutes,
      config.postingWindowStart,
      config.postingWindowEnd,
      new Date(Date.now() + AUTO_POST_JOB_TIMEOUT_MS)
    );
    await updateAutoPostState(config._id, {
      autoPostStatus: "posting",
      jobStatus: "pending",
      lastStatus: "pending",
      lastError: null,
      lastRunAt: triggeredAt,
      nextRunAt: delayedNextRunAt
    });
    await logShopeeStep({
      config,
      step: "JOB_SKIPPED_ACTIVE_PAGE_QUEUE",
      status: "skipped",
      message: `Skipped creating a new Shopee batch because ${openPageJobs} page job(s) are still pending from the current batch.`,
      metadata: {
        openPageJobs,
        selectedPageCount: eligiblePageIds.length,
        nextRunAt: delayedNextRunAt.toISOString()
      }
    });

    return {
      queued: 0,
      workflowId: String(config._id),
      workflowRunId: String(config._id),
      contentItemId: String(config._id)
    };
  }

  await logShopeeStep({
    config,
    step: "VALIDATE_ENV",
    status: "started",
    message: "Checking Shopee affiliate configuration"
  });
  ensureShopeeAffiliateConfigured(config.shopeeTrackingId);
  await logShopeeStep({
    config,
    step: "VALIDATE_FACEBOOK_PAGES",
    status: "started",
    message: "Checking Facebook connection and selected pages",
    metadata: { selectedPageCount: eligiblePageIds.length }
  });
  const facebookConnection = await ensureValidFacebookConnection(config.userId);
  const pageSubIdsByPageId = getPageSubIdsByPageId(facebookConnection);

  const maxPostsPerPage = Math.max(0, config.maxPostsPerPagePerDay ?? 0);
  if ((config.contentSource ?? "shopee-affiliate") !== "shopee-affiliate" && maxPostsPerPage > 0) {
    const limitedPageIds: string[] = [];
    for (const pageId of eligiblePageIds) {
      const postedToday = await countSuccessfulAutoPostsToday(config.userId, config._id, pageId);
      if (postedToday >= maxPostsPerPage) {
        await logShopeeAutomationEvent({
          userId: config.userId,
          level: "warn",
          message: "Duplicate/daily limit guard skipped Shopee page for today",
          pageId,
          metadata: { postedToday, maxPostsPerPage }
        });
      } else {
        limitedPageIds.push(pageId);
      }
    }
    eligiblePageIds = limitedPageIds;
  }

  const maxPostsPerDay = Math.max(0, config.maxPostsPerDay ?? 0);
  if ((config.contentSource ?? "shopee-affiliate") !== "shopee-affiliate" && maxPostsPerDay > 0) {
    const postedToday = await countSuccessfulAutoPostsToday(config.userId, config._id);
    const remaining = Math.max(0, maxPostsPerDay - postedToday);
    eligiblePageIds = eligiblePageIds.slice(0, remaining);
  }

  if (!eligiblePageIds.length) {
    await updateAutoPostState(config._id, {
      autoPostStatus: "waiting",
      jobStatus: "pending",
      lastError: "Daily Shopee Affiliate post limit reached for selected pages",
      lastRunAt: triggeredAt,
      nextRunAt
    });
    throw new Error("Daily Shopee Affiliate post limit reached for selected pages");
  }

  const records = await createAutoPostRecords({
    userId: config.userId,
    configId: config._id,
    folderId: "shopee-affiliate",
    folderName: "Shopee Affiliate",
    pageIds: eligiblePageIds,
    intervalMinutes: config.intervalMinutes,
    captionStrategy: config.captionStrategy,
    captions: config.captions,
    aiPrompt: config.aiPrompt || "",
    language: config.language || "th",
    source: options.source,
    triggeredAt: triggeredAt.toISOString()
  });

  await logShopeeStep({
    config,
    step: "FETCH_SHOPEE_PRODUCTS",
    status: "started",
    message: "Fetching and scoring Shopee products",
    metadata: {
      sourceTag: config.shopeeSourceTag ?? "trending",
      keyword: config.shopeeKeyword ?? "",
      category: config.shopeeCategory ?? "",
      pageCount: eligiblePageIds.length
    }
  });
  const selectedProducts = await selectShopeeProductsForPages({
    userId: config.userId,
    pageIds: eligiblePageIds,
    sourceTag: config.shopeeSourceTag ?? "trending",
    keyword: config.shopeeKeyword,
    category: config.shopeeCategory,
    categoryPriority: config.shopeeCategoryPriority ?? [],
    blockedCategories: config.shopeeBlockedCategories ?? [],
    minPrice: config.shopeeMinPrice ?? 0,
    maxPrice: config.shopeeMaxPrice ?? 0,
    minRating: config.shopeeMinRating ?? 0,
    minSales: config.shopeeMinSales ?? 0,
    minDiscountPercent: config.shopeeMinDiscountPercent ?? 0
  });
  await logShopeeStep({
    config,
    step: "SELECT_PRODUCT",
    status: selectedProducts.length ? "success" : "failed",
    message: selectedProducts.length ? `Selected ${selectedProducts.length} product(s)` : "No eligible product found",
    metadata: { selectedCount: selectedProducts.length }
  });

  let queued = 0;
  let failedPageCount = 0;
  let lastPostId: unknown = null;
  const batchDelayMinutes = options.immediate ? 0 : getRandomDelayMinutes(config.minRandomDelayMinutes ?? 0, config.maxRandomDelayMinutes ?? 0);
  // Even manual Start Now should fan out page publishing gradually. Posting
  // every selected page at once makes Facebook uploads, OpenAI image work, and
  // the monitor compete for the same serverless window.
  const pageSpacingMinutes = Math.max(0, AUTO_POST_BATCH_PAGE_SPACING_MINUTES);
  const batchRequestedStartAt = new Date(Date.now() + batchDelayMinutes * 60 * 1000);
  const batchStartAt = fitBatchStartToPostingWindow(
    batchRequestedStartAt,
    eligiblePageIds.length,
    config.postingWindowStart,
    config.postingWindowEnd
  );
  const effectiveNextRunAt = ensureNextRunAfterBatch(
    nextRunAt,
    batchStartAt,
    eligiblePageIds.length,
    config.postingWindowStart,
    config.postingWindowEnd
  );

  let selectedProductsForQueue =
    SHOPEE_BATCH_PRODUCT_MODE === "single" && selectedProducts.length > 0
      ? eligiblePageIds.map((pageId) => ({ ...selectedProducts[0], pageId }))
      : selectedProducts;
  let sharedSingleProductPackage: ShopeePostPackageResult | null = null;
  let sharedSingleProductPackageKey: string | null = null;

  if (SHOPEE_BATCH_PRODUCT_MODE === "single" && selectedProducts.length > 0) {
    const prepared = await prepareSingleShopeePackageWithProductAttempts({
      config,
      eligiblePageIds,
      pageSubIdsByPageId,
      initialSelectedProducts: selectedProducts,
      records,
      batchStartAt,
      pageSpacingMinutes
    });
    selectedProductsForQueue = prepared.selectedProductsForQueue;
    sharedSingleProductPackage = prepared.packageResult;
    sharedSingleProductPackageKey = prepared.packageCacheKey;
  }

  const selectedProductPageIds = new Set(selectedProductsForQueue.map((selected) => selected.pageId));
  for (let index = 0; index < eligiblePageIds.length; index += 1) {
    const pageId = eligiblePageIds[index];
    if (selectedProductPageIds.has(pageId)) continue;

    failedPageCount += 1;
    const startAt = new Date(batchStartAt.getTime() + index * pageSpacingMinutes * 60 * 1000);
    await createFailedShopeePageJob({
      config,
      pageId,
      pageIndex: index + 1,
      selectedPagesCount: eligiblePageIds.length,
      workflowId: records.workflowId,
      workflowRunId: records.workflowRunId,
      contentItemId: records.contentItemId,
      scheduledAt: startAt,
      error: new Error("No eligible Shopee product found for this page"),
      errorCode: "no_eligible_product",
      failedStep: "SELECT_PRODUCT"
    });
  }

  const packageCache = new Map<string, Awaited<ReturnType<typeof buildShopeePostPackage>>>();
  for (let index = 0; index < selectedProductsForQueue.length; index += 1) {
    const selected = selectedProductsForQueue[index];
    const pageIndex = Math.max(0, eligiblePageIds.indexOf(selected.pageId));
    const startAt = new Date(batchStartAt.getTime() + Math.max(pageIndex, index) * pageSpacingMinutes * 60 * 1000);
    const trackingId = config.shopeeTrackingId?.trim() || `page-${selected.pageId}`;
    const subIds = resolveSubIdsForPage(config, pageSubIdsByPageId, selected.pageId);
    const stepStartedAt = Date.now();
    try {
      await logShopeeStep({
        config,
        step: "GENERATE_POST_PACKAGE",
        status: "started",
        message: "Generating affiliate link, caption, and 4 UGC images",
        pageId: selected.pageId,
        productId: selected.product.productId,
        metadata: {
          score: selected.score.productScore,
          reason: selected.score.reason,
          trackingId,
          subId: subIds.subId,
          subId1: subIds.subId1,
          subId2: subIds.subId2,
          subId3: subIds.subId3,
          subId4: subIds.subId4,
          subId5: subIds.subId5
        }
      });
      const packageCacheKey = getShopeePackageCacheKey({
        productId: selected.product.productId,
        captionStyle: config.shopeeCaptionStyle ?? "soft_sell",
        trackingId,
        subIds
      });
      let packageResult =
        sharedSingleProductPackageKey === packageCacheKey
          ? sharedSingleProductPackage
          : packageCache.get(packageCacheKey);
      if (!packageResult) {
        packageResult = await buildShopeePostPackage({
          userId: config.userId,
          pageId: selected.pageId,
          product: selected.product,
          scheduledAt: startAt,
          captionStyle: config.shopeeCaptionStyle ?? "soft_sell",
          trackingId,
          subIds,
          jobId: records.workflowRunId
        });
        packageCache.set(packageCacheKey, packageResult);
      }
      await logShopeeStep({
        config,
        step: "VALIDATE_POST_PAYLOAD",
        status: "started",
        message: "Validating Shopee short link and image count",
        pageId: selected.pageId,
        productId: selected.product.productId,
        metadata: {
          imageCount: packageResult.generatedImageUrls.length,
          hasShortLink: Boolean(packageResult.shortAffiliateLink),
          trackingId,
          subId: subIds.subId,
          shortAffiliateLink: packageResult.shortAffiliateLink,
          durationMs: Date.now() - stepStartedAt
        }
      });

      if (!packageResult.shortAffiliateLink || packageResult.generatedImageUrls.length < 4) {
        throw new Error("Shopee post package is incomplete: affiliate short link and 4 images are required");
      }

      const postStatus = config.approvalMode ? "draft" : "scheduled";
      const contentHash = hashValue(packageResult.caption);
      const imageHash = hashValue(packageResult.generatedImageUrls);
      const fingerprint = hashValue({
        source: "shopee-affiliate",
        pageId: selected.pageId,
        productId: selected.product.productId,
        contentHash,
        imageHash
      });
      const post = await Post.create({
        userId: config.userId,
        title: `Shopee Affiliate ${selected.product.productName}`,
        content: packageResult.caption,
        hashtags: [],
        imageUrls: packageResult.generatedImageUrls,
        targetPageIds: [selected.pageId],
        randomizeImages: false,
        randomizeCaption: false,
        postingMode: "broadcast",
        variants: [],
        status: postStatus,
        contentHash,
        imageHash,
        fingerprint
      });

      lastPostId = post._id;

      const queuedForPost = config.approvalMode
        ? 0
        : await enqueuePostJobsForPost(config.userId, String(post._id), {
            applyRandomDelay: false,
            startAt,
            payloadExtras: {
              autoPostConfigId: config._id,
              autoSource: "shopee-affiliate",
              shopeeProductId: selected.product.productId,
              shopeeProductName: selected.product.productName,
              shopeeProductScore: selected.score.productScore,
              shopeeSelectionReason: selected.score.reason,
              affiliateLink: packageResult.shortAffiliateLink,
              affiliateUrl: packageResult.affiliateLink,
              imageCount: packageResult.generatedImageUrls.length,
              aiGeneratedPostId: packageResult.aiGeneratedPostId,
              selectedPagesCount: eligiblePageIds.length,
              pageIndex: Math.max(pageIndex, index) + 1,
              scheduledDelayMinutes: batchDelayMinutes + Math.max(pageIndex, index) * pageSpacingMinutes,
              workflowId: records.workflowId,
              workflowRunId: records.workflowRunId,
              contentItemId: records.contentItemId
            }
          });

      await recordShopeeQueueItem({
        userId: config.userId,
        pageId: selected.pageId,
        product: selected.product,
        postId: String(post._id),
        scheduledAt: startAt,
        affiliateLink: packageResult.shortAffiliateLink,
        aiGeneratedPostId: packageResult.aiGeneratedPostId,
        status: config.approvalMode ? "draft" : "queued"
      });

      await logShopeeAutomationEvent({
        userId: config.userId,
        level: "success",
        message: "QUEUE_POST: Shopee affiliate post queued",
        productId: selected.product.productId,
        pageId: selected.pageId,
        metadata: {
          score: selected.score.productScore,
          reason: selected.score.reason,
          scheduledAt: startAt.toISOString()
        }
      });

      queued += queuedForPost;
    } catch (error) {
      failedPageCount += 1;
      await createFailedShopeePageJob({
        config,
        pageId: selected.pageId,
        pageIndex: Math.max(pageIndex, index) + 1,
        selectedPagesCount: eligiblePageIds.length,
        workflowId: records.workflowId,
        workflowRunId: records.workflowRunId,
        contentItemId: records.contentItemId,
        productId: selected.product.productId,
        productName: selected.product.productName,
        scheduledAt: startAt,
        error,
        errorCode: "post_package_failed",
        failedStep: "GENERATE_POST_PACKAGE"
      });
    }
  }

  const allPagesFailed = queued === 0 && !config.approvalMode && failedPageCount >= eligiblePageIds.length;

  await updateAutoPostState(config._id, {
    autoPostStatus: allPagesFailed ? "failed" : config.approvalMode ? "waiting" : "posting",
    jobStatus: "pending",
    lastStatus: allPagesFailed ? "failed" : "pending",
    lastError: allPagesFailed
      ? "All selected pages failed during Shopee post preparation"
      : failedPageCount > 0
        ? `${failedPageCount} selected page(s) failed during Shopee post preparation; remaining pages will continue.`
        : null,
    lastRunAt: triggeredAt,
    nextRunAt: effectiveNextRunAt,
    retryCount: 0,
    lastPostId,
    lastSelectedImageId: null,
    lastWorkflowId: records.workflowId,
    lastWorkflowRunId: records.workflowRunId,
    lastContentItemId: records.contentItemId
  });

  await logAction({
    userId: config.userId,
    type: "queue",
    level: "info",
    message: options.source === "manual-start" ? "Shopee Affiliate Auto Post started" : "Scheduled Shopee Affiliate Auto Post queued",
    relatedPostId: lastPostId ? String(lastPostId) : undefined,
    metadata: {
      autoPost: true,
      shopeeAffiliate: true,
      autoPostConfigId: config._id,
      source: options.source,
      queued,
      eligiblePageIds,
      batchStartAt: batchStartAt.toISOString(),
      batchCompletionAt: getBatchCompletionTime(batchStartAt, eligiblePageIds.length).toISOString(),
      nextRunAt: effectiveNextRunAt.toISOString(),
      workflowId: records.workflowId,
      workflowRunId: records.workflowRunId,
      contentItemId: records.contentItemId
    }
  });

  await logShopeeStep({
    config,
    step: allPagesFailed ? "JOB_FAILED" : failedPageCount > 0 ? "JOB_PARTIAL_SUCCESS" : "JOB_SUCCESS",
    status: allPagesFailed ? "failed" : "success",
    message: allPagesFailed
      ? "No selected page could be prepared for Shopee publishing"
      : failedPageCount > 0
        ? "Shopee posts queued for remaining pages; some pages failed during preparation"
        : config.approvalMode
          ? "Shopee previews created and waiting approval"
          : "Shopee posts queued for Facebook publishing",
    metadata: {
      queued,
      failedPageCount,
      selectedPagesCount: eligiblePageIds.length,
      approvalMode: Boolean(config.approvalMode),
      batchStartAt: batchStartAt.toISOString(),
      batchCompletionAt: getBatchCompletionTime(batchStartAt, eligiblePageIds.length).toISOString(),
      nextRunAt: effectiveNextRunAt.toISOString()
    }
  });

  return {
    queued,
    ...records
  };
}

async function expandExtractedTextToCaption(
  config: LeanAutoPostConfig,
  keyword: string,
  extractedText: string
) {
  const trimmedExtractedText = extractedText.trim();
  if (!trimmedExtractedText) {
    return "";
  }

  const customPrompt = [AUTO_POST_QUOTE_EXPANSION_PROMPT, config.aiPrompt?.trim() || ""]
    .filter(Boolean)
    .join("\n\n");

  try {
    const variants = await generateFacebookContent(keyword, {
      persona: {
        audience: "general audience",
        contentStyle: "social post",
        tone: "gentle and thoughtful",
        pageName: "Auto Post"
      },
      userId: config.userId,
      customPrompt,
      sourceText: `ข้อความจากภาพ:\n${trimmedExtractedText}`,
      sourceLabel: "extracted quote from image"
    });

    const chosen = variants?.length ? randomItem(variants) : null;
    return chosen?.caption?.trim() || "";
  } catch {
    return "";
  }
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
        const expandedCaption = await expandExtractedTextToCaption(config, keyword, primaryText);
        return appendHashtags(expandedCaption || primaryText, config.hashtags);
      }

      const extractedText = await extractExactTextFromImage(imageFile.bytes, imageFile.mimeType);
      if (extractedText) {
        const expandedCaption = await expandExtractedTextToCaption(config, keyword, extractedText);
        return appendHashtags(expandedCaption || extractedText, config.hashtags);
      }
    } catch {
      // Fall through to the explicit failure below.
    }

    throw new Error("AI-only caption mode could not extract readable text from the selected image");
  }
  let extractedText = "";
  try {
    const imageFile = await fetchDriveImageBinary(driveAccessToken, image.id);
    extractedText =
      (await extractPrimaryCreativeTextFromImage(imageFile.bytes, imageFile.mimeType)) ||
      (await extractExactTextFromImage(imageFile.bytes, imageFile.mimeType));
  } catch {
    // Best-effort only for prompt grounding.
  }

  const expandedExtractedCaption = extractedText
    ? await expandExtractedTextToCaption(config, keyword, extractedText)
    : "";

  const sourceParts = [
    manualCaption ? `Manual caption draft:\n${manualCaption}` : "",
    extractedText ? `Text found in image:\n${extractedText}` : "",
    expandedExtractedCaption ? `Expanded caption direction from extracted text:\n${expandedExtractedCaption}` : "",
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

  if (expandedExtractedCaption) {
    return appendHashtags(expandedExtractedCaption, config.hashtags);
  }

  if (extractedText) {
    return appendHashtags(extractedText, config.hashtags);
  }

  return appendHashtags(`Fresh update from ${config.folderName || "your Google Drive"}`, config.hashtags);
}

async function queueAutoPostsForConfig(config: LeanAutoPostConfig, options: QueueAutoPostsOptions): Promise<QueueAutoPostsResult> {
  const triggeredAt = new Date();
  const nextRunAt = getNextAutoRun(config.intervalMinutes, config.postingWindowStart, config.postingWindowEnd, triggeredAt);
  await ensureStorageBeforeAutoPost(config.userId);

  await updateAutoPostState(config._id, {
    autoPostStatus: "running",
    jobStatus: "pending",
    lastStatus: "pending",
    lastError: null,
    retryCount: 0,
    lastRunAt: triggeredAt,
    nextRunAt
  });

  if ((config.contentSource ?? "shopee-affiliate") === "shopee-affiliate") {
    return queueShopeeAutoPostsForConfig(config, options, triggeredAt, nextRunAt);
  }

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

  const records = await createAutoPostRecords({
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
  const { chosenImages, nextDailyUsedImageIds, activeDayKey, nextUsedImageIds } = buildDailyImageSelectionPlan(
    images,
    eligiblePageIds.length,
    dayKey,
    config.dailyImageUsageDate ?? null,
    config.dailyUsedImageIds ?? [],
    config.usedImageIds ?? []
  );
  const batchDelayMinutes = options.immediate ? 0 : getRandomDelayMinutes(config.minRandomDelayMinutes ?? 0, config.maxRandomDelayMinutes ?? 0);
  const batchRequestedStartAt = new Date(Date.now() + batchDelayMinutes * 60 * 1000);
  const batchStartAt = fitBatchStartToPostingWindow(
    batchRequestedStartAt,
    eligiblePageIds.length,
    config.postingWindowStart,
    config.postingWindowEnd
  );

  for (let index = 0; index < eligiblePageIds.length; index += 1) {
    const pageId = eligiblePageIds[index];
    const chosenImage = chosenImages[index] ?? images[index % images.length];
    const caption = await buildCaption(config, chosenImage, driveConnection.accessToken);
    const normalizedHashtags = normalizeHashtags(config.hashtags);
    const startAt = new Date(batchStartAt.getTime() + index * AUTO_POST_BATCH_PAGE_SPACING_MINUTES * 60 * 1000);

    const post = await Post.create({
      userId: config.userId,
      title: `Auto Post ${pageId} ${triggeredAt.toISOString()}`,
      content: caption,
      hashtags: normalizedHashtags,
      imageUrls: [`drive:${chosenImage.id}`],
      targetPageIds: [pageId],
      randomizeImages: false,
      randomizeCaption: false,
      postingMode: "broadcast",
      variants: [],
      status: "scheduled"
    });

    lastPostId = post._id;
    lastSelectedImageId = chosenImage.id;

    const queuedForPost = await enqueuePostJobsForPost(config.userId, String(post._id), {
      applyRandomDelay: false,
      startAt,
      payloadExtras: {
        autoPostConfigId: config._id,
        autoSource: "google-drive",
        selectedFolderId: config.folderId,
        selectedImageId: chosenImage.id,
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
    dailyImageUsageDate: activeDayKey,
    dailyUsedImageIds: nextDailyUsedImageIds,
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
      autoPost: true,
      autoPostConfigId: config._id,
      folderId: config.folderId,
      source: options.source,
      queued,
      eligiblePageIds,
      postingWindowStart: config.postingWindowStart ?? null,
      postingWindowEnd: config.postingWindowEnd ?? null,
      lastSelectedImageId,
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

export async function processAutoPostConfigNow(
  userId: string,
  configId: string,
  options: { processInline?: boolean } = {}
) {
  const config = (await AutoPostConfig.findOne({ _id: configId, userId }).lean()) as unknown as LeanAutoPostConfig | null;

  if (!config) {
    throw new Error("Auto Post settings not found");
  }

  let result: QueueAutoPostsResult;
  try {
    result = await queueAutoPostsForConfig(config, {
      source: "manual-start",
      immediate: true
    });
  } catch (error) {
    const message = normalizeAutoPostError(error);
    await updateAutoPostState(config._id, {
      lastRunAt: new Date(),
      nextRunAt: getNextAutoRun(config.intervalMinutes, config.postingWindowStart, config.postingWindowEnd),
      autoPostStatus: "failed",
      jobStatus: "failed",
      lastStatus: "failed",
      lastError: message
    });
    await logShopeeStep({
      config,
      step: "JOB_FAILED",
      status: "failed",
      message,
      error
    });
    throw error;
  }

  const processedJobs = options.processInline === false
    ? []
    : await processQueuedJobs(Math.max(config.targetPageIds.length, 1));

  return {
    ...result,
    processedJobs
  };
}

export async function processDueAutoPosts() {
  const configs = (await AutoPostConfig.find({
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
      const message = normalizeAutoPostError(error);
      await updateAutoPostState(config._id, {
        lastRunAt: new Date(),
        nextRunAt: getNextAutoRun(config.intervalMinutes, config.postingWindowStart, config.postingWindowEnd),
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastStatus: "failed",
        lastError: message
      });
      await logShopeeStep({
        config,
        step: "JOB_FAILED",
        status: "failed",
        message,
        error
      });

      await logAndNotifyError({
        userId: config.userId,
        message,
        metadata: { autoPost: true, autoPostConfigId: config._id, source: "schedule" },
        error
      });
    }
  }

  return processed;
}


