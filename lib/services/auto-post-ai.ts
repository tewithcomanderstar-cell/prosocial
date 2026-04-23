import { createAutoPostAiRecords } from "@/lib/services/automation-records-ai";
import {
  describeVisualStyleFromImage,
  extractExactTextFromImage,
  extractPrimaryCreativeTextFromImage,
  generateFacebookContent,
  generateMultiImagePersonalityReplies
} from "@/lib/services/ai";
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
  captionLengthMode?: "balanced" | "short";
  captions: string[];
  hashtags?: string[];
  aiPrompt?: string;
  postingWindowStart?: string;
  postingWindowEnd?: string;
  autoCommentEnabled?: boolean;
  autoCommentIntervalMinutes?: 15 | 30 | 60;
  autoCommentLastSyncedAt?: Date | null;
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

type MultiImagePackage = {
  caption: string;
  pinnedComment: string;
  optionReplies: Array<{ optionKey: string; replyText: string }>;
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

function getRotatingMultiImageStyle() {
  const styles = [
    {
      name: "soft-inspiration",
      description:
        "โทนละมุน น่ารัก ชวนหยุดอ่าน เหมือนเพื่อนมาแชร์ไอเดียดีๆ ให้กัน เน้นคำชวนเซฟ ชวนดูทีละรูป"
    },
    {
      name: "playful-social",
      description:
        "โทนสนุก ขี้เล่น อ่านแล้วไหลลื่นแบบโพสต์ที่ชวนคอมเมนต์เลข ชวนเลือกแบบที่ชอบ และชวนแท็กเพื่อน"
    },
    {
      name: "premium-curation",
      description:
        "โทนเรียบหรู ดูคัดมาอย่างตั้งใจ เน้นว่าทุกภาพมีฟีลต่างกัน อ่านแล้วรู้สึกว่าโพสต์นี้มีคุณค่าและน่าเซฟเก็บไว้"
    },
    {
      name: "viral-stop-scroll",
      description:
        "โทน hook แรงขึ้นเล็กน้อย ชวนหยุดเลื่อน ฟีลคอนเทนต์ที่ทำให้คนอยากอ่านจนจบและแชร์ต่อ แต่ยังต้องดูเป็นธรรมชาติไม่ขายเกินไป"
    }
  ];

  return randomItem(styles);
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

function getMinimumMultiImageCount(mode: "4" | "5" | "6-10" = "4") {
  if (mode === "5") return 5;
  if (mode === "6-10") return 6;
  return 4;
}

function resolveMultiImageTargetCountForPage(
  mode: "4" | "5" | "6-10" = "4",
  availableCount: number,
  remainingPageCount: number
) {
  const minimumForCurrentPage = getMinimumMultiImageCount(mode);
  const reserveForOtherPages = Math.max(0, remainingPageCount - 1) * minimumForCurrentPage;
  const maximumForCurrentPage = availableCount - reserveForOtherPages;

  if (maximumForCurrentPage < minimumForCurrentPage) {
    return 0;
  }

  if (mode === "6-10") {
    const upperBound = Math.min(10, maximumForCurrentPage);
    return Math.floor(Math.random() * (upperBound - 6 + 1)) + 6;
  }

  return maximumForCurrentPage >= minimumForCurrentPage ? minimumForCurrentPage : 0;
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

function shortenSentence(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const shortened = normalized.slice(0, maxLength).trim();
  return `${shortened.replace(/[,.!?;:]+$/g, "").trim()}...`;
}

function formatMultiImageCaption(caption: string, mode: "balanced" | "short" = "balanced") {
  const normalizedCaption = caption.replace(/\r\n/g, "\n").trim();
  if (!normalizedCaption) {
    return normalizedCaption;
  }

  const lines = normalizedCaption
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return normalizedCaption;
  }

  const modelLabel = /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*)?แบบ\s*\d+\s*:/u;
  const hashtagLines = lines.filter((line) => line.startsWith("#"));
  const contentLines = lines.filter((line) => !line.startsWith("#"));

  const maxHookLength = mode === "short" ? 42 : 60;
  const maxDetailLength = mode === "short" ? 52 : 78;
  const maxCtaLines = mode === "short" ? 1 : 2;
  const maxNonModelLines = mode === "short" ? 3 : 4;

  const formattedContent: string[] = [];
  const introLines = contentLines.filter((line) => !modelLabel.test(line));
  const modelLines = contentLines.filter((line) => modelLabel.test(line));

  if (introLines[0]) {
    formattedContent.push(shortenSentence(introLines[0], maxHookLength));
  }

  const secondaryIntro = introLines.slice(1, maxNonModelLines).map((line, index, array) => {
    const isLast = index >= array.length - maxCtaLines;
    return shortenSentence(line, isLast ? maxDetailLength : maxHookLength + 12);
  });
  formattedContent.push(...secondaryIntro);

  const formattedModels = modelLines.map((line) => {
    const [label, ...rest] = line.split(":");
    const detail = shortenSentence(rest.join(":").trim(), maxDetailLength);
    return detail ? `${label.trim()} : ${detail}` : label.trim();
  });

  const limitedModels = mode === "short" ? formattedModels.slice(0, 4) : formattedModels;
  formattedContent.push(...limitedModels);

  const trimmedContent = formattedContent.filter(Boolean);
  const maxLines = mode === "short" ? 7 : 11;
  const outputLines = trimmedContent.slice(0, maxLines);

  if (hashtagLines.length) {
    outputLines.push(hashtagLines.join(" "));
  }

  return outputLines.join("\n");
}

function formatPinnedComment(comment: string) {
  const normalized = comment.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return normalized;
  }

  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((line) => shortenSentence(line, 80))
    .join("\n");
}

function deriveImageSummary(sourceChunk: string, fallbackName: string, index: number) {
  const cleaned = sourceChunk
    .replace(/ภาพที่\s*\d+\s*:\s*/g, "")
    .replace(/ธีมหลักที่เห็นคือ\s*/g, "")
    .replace(/ข้อความสำคัญบนภาพคือ\s*/g, "")
    .replace(/ฟีลโดยรวมใกล้เคียงกับ\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const summary = isWeakImageSummary(cleaned)
    ? isWeakImageSummary(fallbackName)
      ? `ไอเดียเล็บแบบที่ ${index + 1}`
      : fallbackName
    : cleaned;
  return shortenSentence(summary, 54);
}

function extractModelDetails(lines: string[]) {
  const details = new Map<number, string>();

  for (const line of lines) {
    const match = /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*)?แบบ\s*(\d+)\s*:\s*(.+)$/iu.exec(line);
    if (!match) continue;
    const modelIndex = Number(match[1]);
    const detail = match[2]?.trim() ?? "";
    if (!detail || isWeakImageSummary(detail)) continue;
    details.set(modelIndex, detail);
  }

  return details;
}

function buildRequiredModelLines(
  sourceChunks: string[],
  images: DriveImage[],
  existingModelDetails?: Map<number, string>
) {
  return images.map((image, index) => {
    const existing = existingModelDetails?.get(index + 1)?.trim();
    const summary =
      existing && !isWeakImageSummary(existing)
        ? existing
        : deriveImageSummary(sourceChunks[index] ?? "", summarizeImageStyleLabel(image.name), index);
    return `แบบ ${index + 1} : ${summary}`;
  });
}

function isWeakImageSummary(value?: string | null) {
  if (!value) return true;
  const normalized = value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) return true;

  if (
    /^(img|image|photo|pic)\b/.test(normalized) ||
    normalized === "milim" ||
    normalized === "nail couture" ||
    normalized === "premium curation" ||
    normalized === "nail set" ||
    normalized === "nail idea set"
  ) {
    return true;
  }

  if (
    normalized.includes("no text found") ||
    normalized.includes("no text detected") ||
    normalized.includes("text found") ||
    normalized.includes("text detected")
  ) {
    return true;
  }

  if (/^img[_\s-]*\d+/.test(normalized)) {
    return true;
  }

  return normalized.length < 4;
}

function ensureCompleteMultiImageCaption(caption: string, requiredModelLines: string[], mode: "balanced" | "short" = "balanced") {
  const normalized = caption.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return formatMultiImageCaption(requiredModelLines.join("\n"), mode);
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const modelLinePattern = /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*)?แบบ\s*\d+\s*:/u;
  const nonModelLines = lines.filter((line) => !modelLinePattern.test(line));
  const completedLines = [...nonModelLines, ...requiredModelLines];

  return formatMultiImageCaption(completedLines.join("\n"), mode);
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

function buildPinnedCommentFromOptionReplies(optionReplies: Array<{ optionKey: string; replyText: string }>) {
  if (!optionReplies.length) {
    return formatPinnedComment(
      "ใครเลือกข้อไหนมาอ่านตรงนี้\n1 อบอุ่นละมุน 2 เนี้ยบมีเสน่ห์ 3 สดใสขี้เล่น 4 มั่นใจมีคาแรกเตอร์\nตรงไหม เมนต์บอกหน่อย"
    );
  }

  const lines = [
    "ใครเลือกข้อไหนมาอ่านตรงนี้",
    ...optionReplies.map((item) => `${item.optionKey}. ${shortenSentence(item.replyText, 46)}`)
  ];

  return formatPinnedComment(lines.join("\n"));
}

async function buildMultiImageOptionReplies(sourceChunks: string[], images: DriveImage[], caption: string) {
  const imageSummaries = images.map((image, index) =>
    deriveImageSummary(sourceChunks[index] ?? "", summarizeImageStyleLabel(image.name), index)
  );

  return generateMultiImagePersonalityReplies({
    imageSummaries,
    caption
  });
}

async function buildMultiImagePackage(config: LeanAutoPostConfig, images: DriveImage[], driveAccessToken: string): Promise<MultiImagePackage> {
  const sampleImages = images.slice(0, Math.min(images.length, 4));
  const sourceChunks: string[] = [];
  const rotatingStyle = getRotatingMultiImageStyle();

  for (const [index, image] of sampleImages.entries()) {
    let creativeText = "";
    let exactText = "";

    try {
      const imageFile = await fetchDriveImageBinary(driveAccessToken, image.id);
      creativeText = await extractPrimaryCreativeTextFromImage(imageFile.bytes, imageFile.mimeType);
      exactText = creativeText ? "" : await extractExactTextFromImage(imageFile.bytes, imageFile.mimeType);
      if (isWeakImageSummary(creativeText) && isWeakImageSummary(exactText)) {
        creativeText = await describeVisualStyleFromImage(imageFile.bytes, imageFile.mimeType);
        exactText = "";
      }
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

  const keyword = `${config.folderName || "Google Drive"} nail idea set`;
  const defaultRequiredModelLines = buildRequiredModelLines(sourceChunks, sampleImages);
  const builtInPrompt =
    `คุณคือผู้เชี่ยวชาญด้านการสร้างคอนเทนต์โซเชียลมีเดียสายไวรัล (Facebook/Instagram) ที่เน้นเพิ่ม Like, Comment, Share และ Time Spent

หน้าที่ของคุณ:
เขียนแคปชันสำหรับโพสต์ "ไอเดียเล็บ" ให้คนหยุดอ่าน อ่านต่อ และอยากมีส่วนร่วม

อินพุต:
- คอนเทนต์เกี่ยวกับ "ไอเดียเล็บหลายแบบ"
- สไตล์การเล่าของโพสต์นี้ให้ยึดแนว ${rotatingStyle.name}: ${rotatingStyle.description}

เอาต์พุต:
เขียนโพสต์โดยใช้โครงสร้างนี้เท่านั้น:

1. Hook เปิด (1-2 บรรทัด)
- ต้องหยุดนิ้วทันที
- ใช้ curiosity เช่น "เล็บ 4 แบบนี้ บอกตัวตนคุณได้"
- หรือ "คนส่วนใหญ่เลือกผิด"

2. คำสั่งให้มีส่วนร่วม (1 บรรทัด)
- เช่น "ลองเลือกแบบที่ชอบที่สุดก่อน"

3. อธิบายแต่ละแบบ (${sampleImages.length} ข้อ)
- แต่ละข้อ:
  - มี emoji
  - อธิบาย "สไตล์ + ความรู้สึก + ตัวตน"
  - ภาษาธรรมชาติ น่ารัก อ่านง่าย
  - สั้น กระชับ 1 บรรทัดต่อข้อ

4. Interactive CTA (2-3 บรรทัด)
- ชวนคอมเมนต์ เช่น "เมนต์เลข 1-${sampleImages.length}"
- มี element เล่นเกม เช่น "เดี๋ยวทายนิสัยให้"
- ชวนเซฟ + แชร์

ข้อกำหนด:
- โทนภาษาเป็นกันเอง น่ารัก ไม่ขายของตรง ๆ
- ไม่เป็นทางการ
- ต้องทำให้คนรู้สึกว่า "เกี่ยวกับตัวเอง"
- ห้ามเขียนเหมือนบทความ
- ห้ามพูดถึงชื่อไฟล์ภาพ
- ห้ามพูดถึงการวิเคราะห์ภาพ
- ห้ามพูดถึง OCR, source, prompt, ไฟล์, หรือข้อความหลังบ้าน
- ห้ามถามกลับเพื่อขอข้อมูลเพิ่ม
- ต้องอิงจากรายละเอียดในภาพจริงเท่านั้น
- ถ้ารายละเอียดบางรูปไม่ชัด ให้สรุปจากธีมที่เห็น แต่ยังต้องเขียนเหมือนโพสต์จริง
- ความยาวรวมของ caption ต้องอยู่ประมาณ ${config.captionLengthMode === "short" ? "8-9" : "8-12"} บรรทัด
- ห้ามใช้ hashtag ในเนื้อโพสต์
- ห้ามเวิ่นหรืออธิบายซ้ำ

Optional:
- เพิ่ม curiosity เช่น "เฉลยอยู่ในคอมเมนต์"
- ใช้คำที่กระตุ้นอารมณ์ เช่น "แอบ", "จริง ๆ", "ส่วนใหญ่"

สิ่งที่ต้องระวัง:
- แม้สไตล์จะเปลี่ยนไปในแต่ละโพสต์ แต่โครงสร้างหลักต้องเหมือนเดิมเสมอ
- ห้ามใช้คำเปิดซ้ำแบบเดิมทุกโพสต์
- ต้องอ่านสบายบนมือถือและดูโล่งตา`;
  const customPrompt = [builtInPrompt, config.aiPrompt?.trim() || ""].filter(Boolean).join("\n\n");
  const fallbackCaption = appendHashtags(
    ensureCompleteMultiImageCaption(
      `เล็บ ${sampleImages.length} แบบนี้ แต่ละแบบให้ฟีลไม่เหมือนกันเลย\nลองเลือกแบบที่ชอบที่สุดก่อน\nเมนต์เลขที่ชอบ เดี๋ยวทายนิสัยให้\nเซฟไว้เป็นเรฟ แล้วแชร์ให้เพื่อนช่วยเลือกได้เลย`,
      defaultRequiredModelLines,
      config.captionLengthMode ?? "balanced"
    ),
    config.hashtags
  );

  try {
    const variants = await generateFacebookContent(keyword, {
      userId: config.userId,
      customPrompt,
      sourceText: sourceChunks.join("\n\n"),
      sourceLabel: "selected image set details"
    });
    const chosen = variants?.length ? randomItem(variants) : null;
    if (chosen) {
      const rawCaption = [chosen.caption, chosen.hashtags.join(" ")].filter(Boolean).join("\n\n");
      const existingModelDetails = extractModelDetails(
        rawCaption
          .replace(/\r\n/g, "\n")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      );
      const requiredModelLines = buildRequiredModelLines(sourceChunks, sampleImages, existingModelDetails);
      const caption = appendHashtags(
        ensureCompleteMultiImageCaption(
          rawCaption,
          requiredModelLines,
          config.captionLengthMode ?? "balanced"
        ),
        config.hashtags
      );
      const optionReplies = await buildMultiImageOptionReplies(sourceChunks, sampleImages, caption);
      return {
        caption,
        pinnedComment: buildPinnedCommentFromOptionReplies(optionReplies),
        optionReplies
      };
    }
  } catch {
    // Fall back below.
  }

  const optionReplies = await buildMultiImageOptionReplies(sourceChunks, sampleImages, fallbackCaption);
  return {
    caption: fallbackCaption,
    pinnedComment: buildPinnedCommentFromOptionReplies(optionReplies),
    optionReplies
  };
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
  for (let index = 0; index < eligiblePageIds.length; index += 1) {
    const pageId = eligiblePageIds[index];
    let selectedImages: DriveImage[] = [];

    if (automationMode === "multi-image-ai") {
      const { availableImages, nextUsedImageIds: rotatedUsedImageIds } = getAvailableImagesForCycle(
        images,
        dayKey,
        dayKey,
        nextDailyUsedImageIds,
        nextRecentImageUsage,
        nextUsedImageIds
      );
      const remainingPageCount = eligiblePageIds.length - index;
      const count = resolveMultiImageTargetCountForPage(
        config.multiImageCountMode ?? "4",
        availableImages.length,
        remainingPageCount
      );
      if (!count) {
        throw new Error(
          `Not enough eligible images to build unique multi-image sets for all selected pages. Available right now: ${availableImages.length}, pages remaining: ${remainingPageCount}, required per page: ${config.multiImageCountMode === "5" ? 5 : config.multiImageCountMode === "6-10" ? "6-10" : 4}.`
        );
      }

      selectedImages = selectSimilarImageGroup(availableImages, count);
      nextUsedImageIds = [...rotatedUsedImageIds, ...selectedImages.map((image) => image.id)];
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
    nextDailyUsedImageIds = [...nextDailyUsedImageIds, ...selectedImageIds];
    nextRecentImageUsage = [
      ...nextRecentImageUsage,
      ...selectedImageIds.map((imageId) => ({ imageId, usedAt: triggeredAt }))
    ];
    selectedImageIdsForRun.push(...selectedImageIds);

    const primaryImage = selectedImages[0];
    const multiImagePackage =
      automationMode === "multi-image-ai"
        ? await buildMultiImagePackage(config, selectedImages, driveConnection.accessToken)
        : null;
    const caption = multiImagePackage?.caption ?? (await buildCaption(config, primaryImage, driveConnection.accessToken));
    const pinnedComment = multiImagePackage?.pinnedComment ?? "";
    const autoCommentOptionReplies = multiImagePackage?.optionReplies ?? [];
    const normalizedHashtags = normalizeHashtags(config.hashtags);
    const startAt = new Date(batchStartAt.getTime() + index * AUTO_POST_BATCH_PAGE_SPACING_MINUTES * 60 * 1000);

    const post = await Post.create({
      userId: config.userId,
      title: `Auto Post ${pageId} ${triggeredAt.toISOString()}`,
      content: caption,
      pinnedComment,
      autoCommentEnabled: Boolean(config.autoCommentEnabled && automationMode === "multi-image-ai"),
      autoCommentMode: automationMode === "multi-image-ai" ? "multi-image-ai" : "standard",
      autoCommentOptionReplies,
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



