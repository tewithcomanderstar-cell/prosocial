import { AutoPostConfig } from "@/models/AutoPostConfig";
import { Job } from "@/models/Job";
import { Post } from "@/models/Post";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import { fetchImagesFromFolder } from "@/lib/services/google-drive";
import { enqueuePostJobsForPost } from "@/lib/services/queue";
import { generateFacebookContent } from "@/lib/services/ai";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { randomItem } from "@/lib/utils";

type AutoPostStatus = "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
type JobStatus = "pending" | "processing" | "posted" | "failed";

type LeanAutoPostConfig = {
  _id: string;
  userId: string;
  enabled: boolean;
  folderId: string;
  folderName?: string;
  targetPageIds: string[];
  intervalHours: number;
  minRandomDelayMinutes?: number;
  maxRandomDelayMinutes?: number;
  maxPostsPerDay?: number;
  maxPostsPerPagePerDay?: number;
  captionStrategy: "manual" | "ai" | "hybrid";
  captions: string[];
  aiPrompt?: string;
  language?: "th" | "en";
  nextRunAt: Date;
  lastRunAt?: Date;
};

type LeanDriveConnection = {
  accessToken: string;
};

type DriveImage = {
  id: string;
  name: string;
  mimeType?: string;
};

function getNextAutoRun(intervalHours: number) {
  const hours = Math.max(1, intervalHours || 1);
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function getRandomDelayMinutes(minMinutes = 0, maxMinutes = 0) {
  const min = Math.max(0, minMinutes);
  const max = Math.max(min, maxMinutes);
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
    enabled: boolean;
    lastStatus: "pending" | "posted" | "failed" | "paused";
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

async function buildCaption(config: LeanAutoPostConfig, image: DriveImage) {
  const manualCaption = config.captions.length > 0 ? randomItem(config.captions) : "";
  const strategy = config.captionStrategy ?? "hybrid";

  if (strategy === "manual") {
    return manualCaption || `Fresh content from ${config.folderName || "Google Drive"}`;
  }

  const keyword = config.aiPrompt?.trim() || image.name || config.folderName || "Google Drive";

  try {
    const variants = await generateFacebookContent(
      keyword,
      {
        audience: config.language === "en" ? "general audience" : "general audience",
        contentStyle: "social post",
        tone: config.language === "en" ? "friendly" : "friendly",
        pageName: "Auto Post"
      },
      config.userId
    );

    const chosen = variants?.length ? randomItem(variants) : null;
    if (chosen) {
      return [chosen.caption, chosen.hashtags.join(" ")].filter(Boolean).join("\n\n");
    }
  } catch {
    // Fall back to manual or default text.
  }

  if (manualCaption) {
    return manualCaption;
  }

  return config.language === "en"
    ? `Fresh update from ${config.folderName || "your Google Drive"}`
    : `Fresh update from ${config.folderName || "your Google Drive"}`;
}

export async function processDueAutoPosts() {
  const configs = (await AutoPostConfig.find({
    enabled: true,
    nextRunAt: { $lte: new Date() }
  }).sort({ nextRunAt: 1 }).lean()) as unknown as LeanAutoPostConfig[];

  let processed = 0;

  for (const config of configs) {
    const nextRunAt = getNextAutoRun(config.intervalHours);

    try {
      await updateAutoPostState(config._id, {
        autoPostStatus: "running",
        jobStatus: "pending",
        lastError: null
      });

      if (!config.targetPageIds.length) {
        await updateAutoPostState(config._id, {
          enabled: false,
          autoPostStatus: "failed",
          jobStatus: "failed",
          lastStatus: "failed",
          lastError: "No Facebook pages selected for Auto Post",
          lastRunAt: new Date(),
          nextRunAt,
          retryCount: 0
        });
        await logAndNotifyError({
          userId: config.userId,
          message: "Auto Post stopped because no Facebook pages were selected",
          metadata: { autoPostConfigId: config._id }
        });
        continue;
      }

      const totalToday = await countSuccessfulAutoPostsToday(config.userId, config._id);
      if (totalToday >= (config.maxPostsPerDay ?? 12)) {
        await updateAutoPostState(config._id, {
          autoPostStatus: "waiting",
          jobStatus: "pending",
          lastStatus: "pending",
          lastError: "Daily Auto Post limit reached",
          lastRunAt: new Date(),
          nextRunAt,
          retryCount: 0
        });
        continue;
      }

      const pageId = randomItem(config.targetPageIds);
      const pageCount = await countSuccessfulAutoPostsToday(config.userId, config._id, pageId);
      if (pageCount >= (config.maxPostsPerPagePerDay ?? 4)) {
        await updateAutoPostState(config._id, {
          autoPostStatus: "waiting",
          jobStatus: "pending",
          lastStatus: "pending",
          lastError: "Per-page daily Auto Post limit reached",
          lastRunAt: new Date(),
          nextRunAt,
          retryCount: 0
        });
        continue;
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
          lastRunAt: new Date(),
          nextRunAt,
          retryCount: 0
        });
        await logAndNotifyError({
          userId: config.userId,
          message: "Auto Post failed because the selected Google Drive folder has no images",
          metadata: { autoPostConfigId: config._id, folderId: config.folderId }
        });
        continue;
      }

      const chosenImage = randomItem(images);
      const caption = await buildCaption(config, chosenImage);
      const delayMinutes = getRandomDelayMinutes(config.minRandomDelayMinutes ?? 0, config.maxRandomDelayMinutes ?? 0);
      const startAt = new Date(Date.now() + delayMinutes * 60 * 1000);

      await updateAutoPostState(config._id, {
        autoPostStatus: "posting",
        jobStatus: "pending",
        lastStatus: "pending",
        lastError: null,
        lastRunAt: new Date(),
        nextRunAt,
        retryCount: 0,
        lastSelectedImageId: chosenImage.id
      });

      const post = await Post.create({
        userId: config.userId,
        title: `Auto Post ${new Date().toISOString()}`,
        content: caption,
        hashtags: [],
        imageUrls: [`drive:${chosenImage.id}`],
        targetPageIds: config.targetPageIds,
        randomizeImages: false,
        randomizeCaption: false,
        postingMode: "random-page",
        variants: [],
        status: "scheduled"
      });

      const queued = await enqueuePostJobsForPost(config.userId, String(post._id), {
        applyRandomDelay: false,
        startAt,
        payloadExtras: {
          autoPostConfigId: config._id,
          autoSource: "google-drive",
          selectedFolderId: config.folderId,
          selectedImageId: chosenImage.id,
          scheduledDelayMinutes: delayMinutes
        }
      });

      await updateAutoPostState(config._id, {
        autoPostStatus: "posting",
        jobStatus: "pending",
        lastStatus: "pending",
        lastError: null,
        lastRunAt: new Date(),
        nextRunAt,
        retryCount: 0,
        lastPostId: post._id,
        lastSelectedImageId: chosenImage.id
      });

      await logAction({
        userId: config.userId,
        type: "queue",
        level: "info",
        message: "Auto Post queued from Google Drive",
        relatedPostId: String(post._id),
        metadata: {
          autoPostConfigId: config._id,
          folderId: config.folderId,
          imageId: chosenImage.id,
          queued,
          targetPageId: pageId,
          scheduledDelayMinutes: delayMinutes,
          autoPostStatus: "waiting",
          jobStatus: "pending"
        }
      });

      processed += queued;
    } catch (error) {
      await updateAutoPostState(config._id, {
        lastRunAt: new Date(),
        nextRunAt,
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastStatus: "failed",
        lastError: error instanceof Error ? error.message : "Auto Post failed"
      });

      await logAndNotifyError({
        userId: config.userId,
        message: error instanceof Error ? error.message : "Unable to process Auto Post",
        metadata: { autoPostConfigId: config._id },
        error
      });
    }
  }

  return processed;
}


