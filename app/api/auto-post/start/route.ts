import { jsonError, jsonOk } from "@/lib/api";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { traceExternalRequest } from "@/lib/services/request-debug";
import { ensureStorageBeforeAutoPost, mapStorageQuotaMessage } from "@/lib/services/storage-cleanup";
import { normalizeShopeeCategories, normalizeShopeeCategory } from "@/lib/shopee-categories";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { after } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type LeanAutoPostConfig = {
  _id: string;
  userId: string;
  enabled: boolean;
  folderId: string;
  folderName: string;
  targetPageIds: string[];
  intervalMinutes: number;
  contentSource?: "shopee-affiliate" | "google-drive";
  shopeeSourceTag?: "trending" | "best_selling" | "top_search" | "best_roi" | "manual";
  shopeeKeyword?: string;
  shopeeCategory?: string;
  shopeeCategories?: string[];
  shopeeCaptionStyle?: "soft_sell" | "urgency" | "problem_solution" | "review_style" | "deal_alert" | "lifestyle";
  captionStrategy: "manual" | "ai" | "hybrid";
  captions: string[];
  aiPrompt: string;
  language: "th" | "en";
  autoPostStatus?: string;
  maxPostsPerDay?: number;
  maxPostsPerPagePerDay?: number;
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

function getAppUrl(request: Request) {
  return process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
}

function getInternalWorkerSecret() {
  return process.env.CRON_SECRET || process.env.AUTO_POST_WORKER_SECRET || "";
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    await ensureStorageBeforeAutoPost(userId);
    const config = (await AutoPostConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;
    const normalizedFolderId = config?.folderId ? normalizeFolderId(config.folderId) : config?.folderId;

    if (config && normalizedFolderId && normalizedFolderId !== config.folderId) {
      await AutoPostConfig.findByIdAndUpdate(config._id, { folderId: normalizedFolderId });
      config.folderId = normalizedFolderId;
    }

    if (!config) {
      return jsonError("Auto Post settings not found", 404);
    }

    if (!config.targetPageIds.length) {
      return jsonError("Select at least one Facebook page first", 400);
    }

    if (config.shopeeSourceTag === "manual" && !config.shopeeKeyword?.trim()) {
      return jsonError("Manual keyword search requires a keyword", 400, "manual_keyword_required");
    }

    if (config.targetPageIds.length > 100) {
      return jsonError("Select up to 100 Facebook pages", 400);
    }

    const activeStatus = ["running", "posting", "retrying"].includes(config.autoPostStatus ?? "");
    const lastRunAtMs = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    const staleActiveJob = activeStatus && lastRunAtMs > 0 && Date.now() - lastRunAtMs > AUTO_POST_JOB_TIMEOUT_MS;

    if (staleActiveJob) {
      const previousStatus = config.autoPostStatus;
      await AutoPostConfig.findByIdAndUpdate(config._id, {
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastStatus: "failed",
        lastError: `Previous Auto Post job timed out after ${AUTO_POST_JOB_TIMEOUT_MS}ms and was cleared before starting a new run.`
      });
      config.autoPostStatus = "failed";
      await logAction({
        userId,
        type: "queue",
        level: "warn",
        message: "Cleared stale Auto Post status before manual start",
        metadata: {
          autoPost: true,
          autoPostConfigId: config._id,
          previousStatus,
          lastRunAt: config.lastRunAt,
          timeoutMs: AUTO_POST_JOB_TIMEOUT_MS
        }
      });
    } else if (activeStatus) {
      return jsonError("Auto Post is already running", 409);
    }

    if ((config.maxPostsPerDay ?? 0) > 0 || (config.maxPostsPerPagePerDay ?? 0) > 0) {
      await AutoPostConfig.findByIdAndUpdate(config._id, {
        maxPostsPerDay: 0,
        maxPostsPerPagePerDay: 0,
        lastError: null
      });
      config.maxPostsPerDay = 0;
      config.maxPostsPerPagePerDay = 0;
    }

    await AutoPostConfig.findByIdAndUpdate(config._id, {
      enabled: true,
      autoPostStatus: "running",
      jobStatus: "processing",
      lastError: null,
      retryCount: 0,
      lastRunAt: new Date(),
      lastStatus: "pending",
      lastPostId: null,
      lastSelectedImageId: null,
      lastWorkflowId: null,
      lastWorkflowRunId: null,
      lastContentItemId: null
    });

    await logAction({
      userId,
      type: "queue",
      level: "info",
      message: "RUN_STATE_RESET_FOR_NEW_START",
      metadata: {
        autoPost: true,
        autoSource: "shopee-affiliate",
        autoPostConfigId: config._id,
        selectedPagesCount: config.targetPageIds.length,
        previousStatus: config.autoPostStatus ?? null,
        source: "manual-start"
      }
    });

    after(() => {
      const workerSecret = getInternalWorkerSecret();
      if (!workerSecret) {
        void AutoPostConfig.findByIdAndUpdate(config._id, {
          autoPostStatus: "failed",
          jobStatus: "failed",
          lastStatus: "failed",
          lastError: "Missing CRON_SECRET or AUTO_POST_WORKER_SECRET for Auto Post worker dispatch"
        }).then(() =>
          logAndNotifyError({
            userId,
            message: "Missing CRON_SECRET or AUTO_POST_WORKER_SECRET for Auto Post worker dispatch",
            metadata: {
              autoPost: true,
              autoPostConfigId: config._id,
              source: "manual-start-after-response",
              action: "dispatch-process-step"
            }
          })
        );
        return;
      }

      const workerUrl = `${getAppUrl(request)}/api/auto-post/process-step`;
      void traceExternalRequest(
        {
          step: "AUTO_POST_WORKER_TRIGGER",
          url: workerUrl,
          fn: "POST /api/auto-post/start",
          source: "internal_worker_fetch",
          userId,
          metadata: {
            autoPostConfigId: String(config._id),
            targetPages: config.targetPageIds.length
          }
        },
        () => fetch(workerUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${workerSecret}`
          },
          body: JSON.stringify({
            userId,
            configId: config._id,
            mode: "both",
            limit: Math.max(config.targetPageIds.length, 1)
          })
        })
      ).catch(async (error) => {
        await AutoPostConfig.findByIdAndUpdate(config._id, {
          autoPostStatus: "failed",
          jobStatus: "failed",
          lastStatus: "failed",
          lastError: error instanceof Error ? error.message : "Unable to dispatch Auto Post worker"
        });
        await logAndNotifyError({
          userId,
          message: error instanceof Error ? error.message : "Unable to dispatch Auto Post worker",
          metadata: {
            autoPost: true,
            autoPostConfigId: config._id,
            source: "manual-start-after-response",
            action: "dispatch-process-step",
            failedStep: "DISPATCH_WORKER"
          },
          error
        });
      });
    });

    after(async () => {
      try {
        await logAction({
          userId,
          type: "queue",
          level: "info",
          message: "Auto Post worker dispatch queued",
          metadata: {
            autoPost: true,
            autoPostConfigId: config._id,
            source: "manual-start-after-response",
            workerEndpoint: "/api/auto-post/process-step",
            processingMode: "separate-worker-invocation"
          }
        });
      } catch (error) {
        await AutoPostConfig.findByIdAndUpdate(config._id, {
          autoPostStatus: "failed",
          jobStatus: "failed",
          lastStatus: "failed",
          lastError: error instanceof Error ? error.message : "Auto Post background publisher failed"
        });
        await logAndNotifyError({
          userId,
          message: error instanceof Error ? error.message : "Auto Post background publisher failed",
          metadata: {
            autoPost: true,
            autoPostConfigId: config._id,
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
      level: "info",
      message: "Auto Post trigger accepted",
      metadata: {
        autoPost: true,
        autoPostConfigId: config._id,
        contentSource: "shopee-affiliate",
        shopeeSourceTag: config.shopeeSourceTag ?? "trending",
        shopeeKeyword: config.shopeeKeyword ?? "",
        shopeeCategory: normalizeShopeeCategory(config.shopeeCategory),
        shopeeCategories: normalizeShopeeCategories(config.shopeeCategories?.length ? config.shopeeCategories : config.shopeeCategory),
        targetPageCount: config.targetPageIds.length,
        intervalMinutes: config.intervalMinutes,
        source: "manual-start",
        destination: "in-app-automation-engine",
        queued: 0,
        processedJobs: 0,
        processingMode: "accepted-background"
      }
    });

    return jsonOk(
      {
        started: true,
        jobId: String(config._id),
        selectedPagesCount: config.targetPageIds.length,
        queued: 0,
        processedJobs: [],
        processingMode: "accepted-background"
      },
      "Auto Post accepted. The publisher will run in the background."
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
        message: error instanceof Error ? error.message : "Unable to trigger Auto Post",
        metadata: { autoPost: true, source: "manual-start", destination: "in-app-automation-engine", action: "start" },
        error
      });
    } catch (loggingError) {
      if (loggingError instanceof Error && loggingError.message === "UNAUTHORIZED") {
        return jsonError("Unauthorized", 401);
      }
      console.error("[auto-post/start] unable to persist start error", {
        message: loggingError instanceof Error ? loggingError.message : "Unknown logging error"
      });
    }

    const quotaMessage = mapStorageQuotaMessage(error);
    const sanitizedMessage = sanitizeLegacyMessage(error instanceof Error ? error.message : null);
    return jsonError(quotaMessage ?? sanitizedMessage ?? "Unable to trigger Auto Post", quotaMessage ? 507 : 500, quotaMessage ? "storage_quota_full" : undefined);
  }
}
