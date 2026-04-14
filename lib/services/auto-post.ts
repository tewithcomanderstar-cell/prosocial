import { createAutoPostRecords } from "@/lib/services/automation-records";
import { extractExactTextFromImage, extractPrimaryCreativeTextFromImage, generateFacebookContent } from "@/lib/services/ai";
import { fetchDriveImageBinary, fetchImagesFromFolder } from "@/lib/services/google-drive";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { enqueuePostJobsForPost, processQueuedJobs } from "@/lib/services/queue";
import { randomItem } from "@/lib/utils";
import { AutoPostConfig } from "@/models/AutoPostConfig";
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
  captions: string[];
  hashtags?: string[];
  aiPrompt?: string;
  language?: "th" | "en";
  nextRunAt: Date;
  lastRunAt?: Date;
  usedImageIds?: string[];
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

function getNextAutoRun(intervalMinutes: number) {
  const minutes = [15, 30, 60, 120].includes(intervalMinutes) ? intervalMinutes : 60;
  return new Date(Date.now() + minutes * 60 * 1000);
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

function buildImageSelectionPlan(images: DriveImage[], pageCount: number, usedImageIds: string[] = []) {
  if (!images.length || pageCount <= 0) {
    return {
      chosenImages: [] as DriveImage[],
      nextUsedImageIds: usedImageIds
    };
  }

  const imageMap = new Map(images.map((image) => [image.id, image]));
  let remainingPool = randomizeOrder(images.filter((image) => !usedImageIds.includes(image.id)));
  let recycledPool = randomizeOrder(images);
  const chosenImages: DriveImage[] = [];
  const consumedIds: string[] = [];

  while (chosenImages.length < pageCount) {
    if (!remainingPool.length) {
      recycledPool = randomizeOrder(images.filter((image) => !consumedIds.includes(image.id)));
      if (!recycledPool.length) {
        recycledPool = randomizeOrder(images);
      }
      remainingPool = recycledPool;
      consumedIds.length = 0;
    }

    const nextImage = remainingPool.shift();
    if (!nextImage) {
      break;
    }

    chosenImages.push(nextImage);
    consumedIds.push(nextImage.id);
  }

  const sequence = [...usedImageIds];
  for (const image of chosenImages) {
    sequence.push(image.id);
  }

  const uniqueRecentIds = sequence.filter((imageId, index) => sequence.indexOf(imageId) === index);
  const nextUsedImageIds =
    uniqueRecentIds.length >= images.length ? chosenImages.map((image) => image.id) : uniqueRecentIds.filter((imageId) => imageMap.has(imageId));

  return {
    chosenImages,
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
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

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

async function queueAutoPostsForConfig(config: LeanAutoPostConfig, options: QueueAutoPostsOptions): Promise<QueueAutoPostsResult> {
  const triggeredAt = new Date();
  const nextRunAt = getNextAutoRun(config.intervalMinutes);

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
  const { chosenImages, nextUsedImageIds } = buildImageSelectionPlan(
    images,
    eligiblePageIds.length,
    config.usedImageIds ?? []
  );

  for (let index = 0; index < eligiblePageIds.length; index += 1) {
    const pageId = eligiblePageIds[index];
    const chosenImage = chosenImages[index] ?? images[index % images.length];
    const caption = await buildCaption(config, chosenImage, driveConnection.accessToken);
    const normalizedHashtags = normalizeHashtags(config.hashtags);
    const delayMinutes = options.immediate ? 0 : getRandomDelayMinutes(config.minRandomDelayMinutes ?? 0, config.maxRandomDelayMinutes ?? 0);
    const startAt = new Date(Date.now() + delayMinutes * 60 * 1000);

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
        scheduledDelayMinutes: delayMinutes,
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

export async function processAutoPostConfigNow(userId: string, configId: string) {
  const config = (await AutoPostConfig.findOne({ _id: configId, userId }).lean()) as unknown as LeanAutoPostConfig | null;

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
      const result = await queueAutoPostsForConfig(config, {
        source: "schedule",
        immediate: false
      });
      processed += result.queued;
    } catch (error) {
      await updateAutoPostState(config._id, {
        lastRunAt: new Date(),
        nextRunAt: getNextAutoRun(config.intervalMinutes),
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastStatus: "failed",
        lastError: error instanceof Error ? error.message : "Auto Post failed"
      });

      await logAndNotifyError({
        userId: config.userId,
        message: error instanceof Error ? error.message : "Unable to process Auto Post",
        metadata: { autoPost: true, autoPostConfigId: config._id, source: "schedule" },
        error
      });
    }
  }

  return processed;
}
