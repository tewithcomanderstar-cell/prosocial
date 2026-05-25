import { jsonError, jsonOk } from "@/lib/api";
import { processAutoPostAiConfigNow } from "@/lib/services/auto-post-ai";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { processQueuedJobs } from "@/lib/services/queue";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
import { Job } from "@/models/Job";
import { after } from "next/server";

type LeanAutoPostConfig = {
  _id: string;
  userId: string;
  enabled: boolean;
  folderId: string;
  folderName: string;
  targetPageIds: string[];
  intervalMinutes: number;
  captionStrategy: "manual" | "ai" | "hybrid";
  captions: string[];
  aiPrompt: string;
  language: "th" | "en";
  autoPostStatus?: string;
  lastRunAt?: Date | string | null;
};

function sanitizeLegacyMessage(value?: string | null) {
  if (!value) return value ?? null;

  const normalized = value.toLowerCase();
  if (
    normalized.includes("n8n") ||
    normalized.includes("requested webhook") ||
    normalized.includes("workflow must be active") ||
    normalized.includes("webhook")
  ) {
    return "Legacy automation state detected. Please refresh and trigger Start Now again.";
  }

  return value;
}

const BROKEN_FOLDER_ID = "1sbp9Ql8moMDs9xBSha5IWoKdE1WlEEWz";
const FIXED_FOLDER_ID = "1sbp9Ql8moMDs9xBSha5lWoKdE1WiEEWz";
const AUTO_POST_JOB_TIMEOUT_MS = Number(process.env.AUTO_POST_JOB_TIMEOUT_MS ?? "300000");

function normalizeFolderId(value: string) {
  const trimmed = value.trim();
  return trimmed === BROKEN_FOLDER_ID ? FIXED_FOLDER_ID : trimmed;
}

async function finalizeBackgroundPublisherState(input: {
  userId: string;
  configId: string;
  workflowRunId?: string | null;
  selectedPagesCount: number;
  processedJobsCount: number;
}) {
  const query: Record<string, unknown> = {
    userId: input.userId,
    type: "post",
    "payload.autoPostAiConfigId": input.configId
  };

  if (input.workflowRunId) {
    query["payload.workflowRunId"] = input.workflowRunId;
  }

  const jobs = (await Job.find(query)
    .sort({ createdAt: 1 })
    .select("status attempts targetPageId failureReason lastError errorCode nextRunAt completedAt")
    .lean()) as Array<{
    status?: string;
    attempts?: number;
    targetPageId?: string;
    failureReason?: string;
    lastError?: string;
    errorCode?: string;
    nextRunAt?: Date | string | null;
  }>;

  if (!jobs.length) {
    await AutoPostAiConfig.findByIdAndUpdate(input.configId, {
      autoPostStatus: "failed",
      jobStatus: "failed",
      lastStatus: "failed",
      lastError: "Auto Post AI publisher completed but no queued Facebook publish jobs were found."
    });
    return {
      autoPostStatus: "failed",
      message: "No queued Facebook publish jobs were found.",
      jobsCount: 0,
      successCount: 0,
      failedCount: 0,
      pendingCount: 0
    };
  }

  const selectedPagesCount = Math.max(input.selectedPagesCount, jobs.length);
  const successCount = jobs.filter((job) => job.status === "success").length;
  const failedJobs = jobs.filter((job) => job.status === "failed" || job.status === "duplicate_blocked");
  const failedCount = failedJobs.length;
  const activeCount = jobs.filter((job) => job.status === "processing").length;
  const retryingCount = jobs.filter((job) => job.status === "retrying" || job.status === "rate_limited").length;
  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const pendingCount = Math.max(0, selectedPagesCount - successCount - failedCount);
  const latestFailure = failedJobs[failedJobs.length - 1] ?? null;
  const latestFailureMessage =
    latestFailure?.failureReason ||
    latestFailure?.lastError ||
    (latestFailure?.errorCode ? `Publish failed with ${latestFailure.errorCode}` : null);
  const pendingRunAt = jobs
    .filter((job) => job.status === "queued" || job.status === "retrying" || job.status === "rate_limited")
    .map((job) => (job.nextRunAt ? new Date(job.nextRunAt).getTime() : Number.POSITIVE_INFINITY))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)[0];

  let autoPostStatus: "posting" | "waiting" | "success" | "failed" | "retrying";
  let jobStatus: "pending" | "processing" | "posted" | "failed";
  let lastStatus: "pending" | "posted" | "failed";
  let lastError: string | null = null;
  let message: string;

  if (activeCount > 0) {
    autoPostStatus = "posting";
    jobStatus = "processing";
    lastStatus = "pending";
    message = `Publishing pages: ${successCount}/${selectedPagesCount} done, ${pendingCount} pending.`;
  } else if (retryingCount > 0) {
    autoPostStatus = "retrying";
    jobStatus = "pending";
    lastStatus = "pending";
    lastError = latestFailureMessage;
    message = `Publishing will retry: ${successCount}/${selectedPagesCount} done, ${retryingCount} retrying.`;
  } else if (queuedCount > 0) {
    autoPostStatus = "waiting";
    jobStatus = "pending";
    lastStatus = "pending";
    message = `Facebook publish jobs are queued: ${successCount}/${selectedPagesCount} done, ${queuedCount} waiting.`;
  } else if (successCount === selectedPagesCount && selectedPagesCount > 0) {
    autoPostStatus = "success";
    jobStatus = "posted";
    lastStatus = "posted";
    message = `Published to all ${selectedPagesCount} selected page(s).`;
  } else if (successCount > 0) {
    autoPostStatus = "success";
    jobStatus = "posted";
    lastStatus = "posted";
    lastError = latestFailureMessage ?? `Published ${successCount}/${selectedPagesCount} page(s); ${failedCount} failed.`;
    message = lastError;
  } else {
    autoPostStatus = "failed";
    jobStatus = "failed";
    lastStatus = "failed";
    lastError = latestFailureMessage ?? "Publishing failed for all selected pages.";
    message = lastError;
  }

  await AutoPostAiConfig.findByIdAndUpdate(input.configId, {
    autoPostStatus,
    jobStatus,
    lastStatus,
    lastError,
    retryCount: Math.max(...jobs.map((job) => Number(job.attempts ?? 0)), 0),
    lastRunAt: new Date(),
    ...(pendingRunAt ? { nextRunAt: new Date(pendingRunAt) } : {})
  });

  return {
    autoPostStatus,
    message,
    jobsCount: jobs.length,
    successCount,
    failedCount,
    pendingCount,
    processedJobsCount: input.processedJobsCount
  };
}

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const config = (await AutoPostAiConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;
    const normalizedFolderId = config?.folderId ? normalizeFolderId(config.folderId) : config?.folderId;

    if (config && normalizedFolderId && normalizedFolderId !== config.folderId) {
      await AutoPostAiConfig.findByIdAndUpdate(config._id, { folderId: normalizedFolderId });
      config.folderId = normalizedFolderId;
    }

    if (!config) {
      return jsonError("Auto Post AI settings not found", 404);
    }

    if (!normalizedFolderId) {
      return jsonError("Select a Google Drive folder first", 400);
    }

    if (!config.targetPageIds.length) {
      return jsonError("Select at least one Facebook page first", 400);
    }

    if (config.targetPageIds.length > 100) {
      return jsonError("Select up to 100 Facebook pages", 400);
    }

    const activeStatus = ["running", "posting", "retrying"].includes(config.autoPostStatus ?? "");
    const lastRunAtMs = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    const staleActiveJob = activeStatus && lastRunAtMs > 0 && Date.now() - lastRunAtMs > AUTO_POST_JOB_TIMEOUT_MS;

    if (staleActiveJob) {
      const previousStatus = config.autoPostStatus;
      await AutoPostAiConfig.findByIdAndUpdate(config._id, {
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastStatus: "failed",
        lastError: `Previous Auto Post AI job timed out after ${AUTO_POST_JOB_TIMEOUT_MS}ms and was cleared before starting a new run.`
      });
      config.autoPostStatus = "failed";
      await logAction({
        userId,
        type: "queue",
        level: "warn",
        message: "Cleared stale Auto Post AI status before manual start",
        metadata: {
          autoPostAi: true,
          autoPostAiConfigId: config._id,
          previousStatus,
          lastRunAt: config.lastRunAt,
          timeoutMs: AUTO_POST_JOB_TIMEOUT_MS
        }
      });
    } else if (activeStatus) {
      return jsonError("Auto Post AI is already running", 409);
    }

    await AutoPostAiConfig.findByIdAndUpdate(config._id, {
      enabled: true,
      autoPostStatus: "running",
      jobStatus: "processing",
      lastError: null,
      retryCount: 0,
      lastRunAt: new Date()
    });

    const result = await processAutoPostAiConfigNow(userId, config._id, { processInline: false });

    after(async () => {
      try {
        const processedJobs = await processQueuedJobs(Math.max(config.targetPageIds.length, 1), "post");
        const finalState = await finalizeBackgroundPublisherState({
          userId,
          configId: String(config._id),
          workflowRunId: result.workflowRunId || null,
          selectedPagesCount: config.targetPageIds.length,
          processedJobsCount: processedJobs.length
        });
        await logAction({
          userId,
          type: "queue",
          level: "info",
          message: `Auto Post AI background publisher completed: ${finalState.message}`,
          metadata: {
            autoPostAi: true,
            autoPostAiConfigId: config._id,
            source: "manual-start-after-response",
            processedJobs: processedJobs.length,
            ...finalState
          }
        });
      } catch (error) {
        await AutoPostAiConfig.findByIdAndUpdate(config._id, {
          autoPostStatus: "failed",
          jobStatus: "failed",
          lastStatus: "failed",
          lastError: error instanceof Error ? error.message : "Auto Post AI background publisher failed"
        });
        await logAndNotifyError({
          userId,
          message: error instanceof Error ? error.message : "Auto Post AI background publisher failed",
          metadata: {
            autoPostAi: true,
            autoPostAiConfigId: config._id,
            source: "manual-start-after-response",
            action: "publish-queued-jobs"
          },
          error
        });
      }
    });

    await logAction({
      userId,
      type: "queue",
      level: result.waiting ? "info" : "success",
      message: result.waiting ? result.message || "Auto Post AI is waiting for more eligible images" : "Auto Post AI triggered in-app",
      metadata: {
        autoPostAi: true,
        autoPostAiConfigId: config._id,
        folderId: normalizedFolderId,
        targetPageCount: config.targetPageIds.length,
        intervalMinutes: config.intervalMinutes,
        source: "manual-start",
        destination: "in-app-automation-engine",
        queued: result.queued,
        processedJobs: 0,
        processingMode: "queued-background",
        autoPostStatus: result.waiting ? "waiting" : "running",
        workflowId: result.workflowId,
        workflowRunId: result.workflowRunId,
        contentItemId: result.contentItemId
      }
    });

    return jsonOk(
      {
        started: !result.waiting,
        waiting: Boolean(result.waiting),
        queued: result.queued,
        processedJobs: result.processedJobs,
        workflowId: result.workflowId,
        workflowRunId: result.workflowRunId,
        contentItemId: result.contentItemId,
        message: result.message ?? null
      },
      result.waiting ? result.message || "Auto Post AI is waiting for more eligible images" : "Auto Post AI started successfully"
    );
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") {
      return handleRoleError(error);
    }

    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("Unauthorized", 401);
    }

    try {
      const { requireAuth } = await import("@/lib/api");
      const userId = await requireAuth();
      await logAndNotifyError({
        userId,
        message: error instanceof Error ? error.message : "Unable to trigger Auto Post AI",
        metadata: { autoPostAi: true, source: "manual-start", destination: "in-app-automation-engine", action: "start" },
        error
      });
    } catch {
      return jsonError("Unauthorized", 401);
    }

    const sanitizedMessage = sanitizeLegacyMessage(error instanceof Error ? error.message : null);
    return jsonError(sanitizedMessage ?? "Unable to trigger Auto Post AI", 500);
  }
}
