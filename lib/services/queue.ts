import { randomUUID } from "crypto";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { Job } from "@/models/Job";
import { MediaCache } from "@/models/MediaCache";
import { Post } from "@/models/Post";
import { Schedule } from "@/models/Schedule";
import { updateAutoPostRecords } from "@/lib/services/automation-records";
import { FacebookPublishError, publishPostToFacebook } from "@/lib/services/facebook";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import { fetchDriveImageBinary } from "@/lib/services/google-drive";
import { recordMetricSnapshot } from "@/lib/services/analytics";
import { isDuplicatePostBlocked } from "@/lib/services/duplicate";
import { contentFingerprint } from "@/lib/services/fingerprint";
import { logAction, logAndNotifyError, serializeError } from "@/lib/services/logging";
import { checkRateLimits } from "@/lib/services/rate-limit";
import { getUserSettings, randomDelayMs } from "@/lib/services/settings";
import { computeNextRunAt, randomItem } from "@/lib/utils";

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
  postId: string;
  scheduleId?: string;
  targetPageId: string;
  attempts: number;
  maxAttempts: number;
  fingerprint?: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
};

type EnqueueOptions = {
  scheduleId?: string;
  applyRandomDelay?: boolean;
  startAt?: Date;
  payloadExtras?: Record<string, unknown>;
};

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

async function acquireNextRunnableJob(): Promise<Record<string, unknown> | null> {
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const correlationId = randomUUID();

  const job = await Job.findOneAndUpdate(
    {
      status: { $in: ["queued", "retrying", "rate_limited"] },
      nextRunAt: { $lte: now },
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
  for (const page of selectedPages) {
    const fingerprint = post.fingerprint ?? contentFingerprint({
      content: post.content,
      hashtags: post.hashtags,
      imageUrls: post.imageUrls,
      targetPageIds: [page.pageId]
    });

    const nextRunAt = options.startAt
      ? new Date(options.startAt)
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
  const { settings } = await getUserSettings(job.userId);
  const safeSettings = {
    duplicateWindowHours: settings?.duplicateWindowHours ?? 24
  };

  const rateLimit = await checkRateLimits(job.userId, "post");
  if (!rateLimit.allowed) {
    const nextRetryAt = new Date(Date.now() + 30 * 60 * 1000);
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
        targetPageId: job.targetPageId,
        autoPostConfigId: job.payload?.autoPostConfigId,
        correlationId: job.correlationId,
        nextRetryAt: nextRetryAt.toISOString(),
        reason: rateLimit.reason
      }
    });

    if (job.payload?.autoPostConfigId) {
      await AutoPostConfig.findByIdAndUpdate(String(job.payload.autoPostConfigId), {
        autoPostStatus: "retrying",
        jobStatus: "pending",
        lastStatus: "failed",
        retryCount: (job.attempts ?? 0) + 1,
        lastError: rateLimit.reason ?? "Rate limited"
      });
      await updateAutoPostRecords({
        configId: String(job.payload.autoPostConfigId),
        autoPostStatus: "retrying",
        currentJobStatus: "pending",
        lastError: rateLimit.reason ?? "Rate limited",
        message: rateLimit.reason ?? "Rate limited",
        pageId: job.targetPageId,
        imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
      });
    }

    return { status: "rate_limited" };
  }

  if (job.fingerprint) {
    const blocked = await isDuplicatePostBlocked({
      userId: job.userId,
      fingerprint: job.fingerprint,
      duplicateWindowHours: safeSettings.duplicateWindowHours
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
        metadata: { targetPageId: job.targetPageId, autoPostConfigId: job.payload?.autoPostConfigId }
      });
      if (job.payload?.autoPostConfigId) {
        await AutoPostConfig.findByIdAndUpdate(String(job.payload.autoPostConfigId), {
          autoPostStatus: "failed",
          jobStatus: "failed",
          lastStatus: "failed",
          retryCount: job.attempts ?? 0,
          lastError: "Duplicate auto post was blocked by duplicate protection"
        });
        await updateAutoPostRecords({
          configId: String(job.payload.autoPostConfigId),
          autoPostStatus: "failed",
          currentJobStatus: "failed",
          lastError: "Duplicate auto post was blocked by duplicate protection",
          message: "Duplicate auto post was blocked by duplicate protection",
          pageId: job.targetPageId,
          imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
        });
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

  const variants = post.variants?.length ? post.variants : [{ caption: post.content, hashtags: post.hashtags }];
  const chosenVariant = post.randomizeCaption ? randomItem(variants) : variants[0];
  const message = [chosenVariant.caption, chosenVariant.hashtags.join(" ")].filter(Boolean).join("\n\n");
  const imageRefs = post.randomizeImages && post.imageUrls.length > 0 ? [randomItem(post.imageUrls)] : post.imageUrls;
  const images = await resolveImages(job.userId, imageRefs);

  if (job.payload?.autoPostConfigId) {
    await AutoPostConfig.findByIdAndUpdate(String(job.payload.autoPostConfigId), {
      autoPostStatus: "posting",
      jobStatus: "processing",
      lastStatus: "pending",
      lastError: null
    });
    await updateAutoPostRecords({
      configId: String(job.payload.autoPostConfigId),
      autoPostStatus: "posting",
      currentJobStatus: "processing",
      lastError: null,
      message: "Publishing to Facebook page",
      pageId: job.targetPageId,
      imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
    });
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
      targetPageId: page.pageId,
      publishResult,
      autoPostConfigId: job.payload?.autoPostConfigId,
      correlationId: job.correlationId
    }
  });

  if (job.payload?.autoPostConfigId) {
    await AutoPostConfig.findByIdAndUpdate(String(job.payload.autoPostConfigId), {
      autoPostStatus: "waiting",
      jobStatus: "posted",
      lastStatus: "posted",
      retryCount: 0,
      lastError: null,
      lastPostId: post._id,
      lastRunAt: new Date()
    });
    await updateAutoPostRecords({
      configId: String(job.payload.autoPostConfigId),
      autoPostStatus: "waiting",
      currentJobStatus: "posted",
      lastError: null,
      message: "Post published successfully",
      pageId: page.pageId,
      imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined,
      lastRunAt: new Date().toISOString()
    });
  }

  return { status: "success" };
}

export async function processQueuedJobs(limit = 10) {
  const processed: Array<{ jobId: string; status: string }> = [];
  let processedCount = 0;

  while (processedCount < limit) {
    const item = await acquireNextRunnableJob();
    if (!item) {
      break;
    }

    const job: JobExecution = {
      _id: String(item._id),
      userId: String(item.userId),
      postId: String(item.postId),
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
        type: "queue",
        level: "info",
        message: `[PUBLISHER] post ${job.postId} started`,
        relatedJobId: job._id,
        relatedPostId: job.postId,
        relatedScheduleId: job.scheduleId,
        metadata: {
          targetPageId: job.targetPageId,
          correlationId: job.correlationId,
          attempt: job.attempts + 1
        }
      });
      const result = await executePostJob(job);
      processed.push({ jobId: job._id, status: result.status });
    } catch (error) {
      const failure = classifyPublishFailure(error);
      const attempts = job.attempts + 1;
      const shouldRetry = failure.retryable && attempts < job.maxAttempts;
      const nextRetryAt = shouldRetry ? new Date(Date.now() + getRetryDelayMs(attempts - 1)) : null;

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

      await Post.findByIdAndUpdate(job.postId, {
        status: shouldRetry ? "retrying" : "failed",
        $inc: { failedCount: 1 }
      });

      await logAndNotifyError({
        userId: job.userId,
        message: shouldRetry
          ? `[PUBLISHER] post ${job.postId} failed and will retry (${attempts}/${job.maxAttempts}): ${failure.failureReason}`
          : `[PUBLISHER] post ${job.postId} failed after ${attempts} attempts: ${failure.failureReason}`,
        metadata: {
          targetPageId: job.targetPageId,
          attempts,
          maxAttempts: job.maxAttempts,
          autoPostConfigId: job.payload?.autoPostConfigId,
          correlationId: job.correlationId,
          errorCode: failure.errorCode,
          nextRetryAt: nextRetryAt?.toISOString()
        },
        relatedJobId: job._id,
        relatedPostId: job.postId,
        relatedScheduleId: job.scheduleId,
        error
      });

      if (job.payload?.autoPostConfigId) {
        await AutoPostConfig.findByIdAndUpdate(String(job.payload.autoPostConfigId), {
          autoPostStatus: shouldRetry ? "retrying" : "failed",
          jobStatus: "failed",
          lastStatus: shouldRetry ? "pending" : "failed",
          retryCount: attempts,
          lastError: failure.failureReason
        });
        await updateAutoPostRecords({
          configId: String(job.payload.autoPostConfigId),
          autoPostStatus: shouldRetry ? "retrying" : "failed",
          currentJobStatus: shouldRetry ? "pending" : "failed",
          lastError: failure.failureReason,
          message: shouldRetry
            ? `Publish failed and will retry (${attempts}/${job.maxAttempts})`
            : `Publish failed after ${attempts} attempts`,
          pageId: job.targetPageId,
          imageUsed: typeof job.payload?.selectedImageId === "string" ? job.payload.selectedImageId : undefined
        });
      }

      processed.push({ jobId: job._id, status: shouldRetry ? "retrying" : "failed" });
    }

    processedCount += 1;
  }

  return processed;
}





