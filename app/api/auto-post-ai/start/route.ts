import { jsonError, jsonOk } from "@/lib/api";
import { processAutoPostAiConfigNow } from "@/lib/services/auto-post-ai";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { processQueuedJobs } from "@/lib/services/queue";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
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
        await logAction({
          userId,
          type: "queue",
          level: "info",
          message: "Auto Post AI background publisher completed",
          metadata: {
            autoPostAi: true,
            autoPostAiConfigId: config._id,
            source: "manual-start-after-response",
            processedJobs: processedJobs.length
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

