import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { ActionLog } from "@/models/ActionLog";
import { FacebookConnection } from "@/models/FacebookConnection";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { Job } from "@/models/Job";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { getShopeeAffiliateConfigStatus, getShopeeEnvStatus, getShopeeProductProvider } from "@/lib/services/shopee-affiliate";
import { getStorageStatus, mapStorageQuotaMessage } from "@/lib/services/storage-cleanup";

type AutoPostConfigStatusDoc = {
  _id: unknown;
  autoPostStatus?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  targetPageIds?: string[];
  lastWorkflowRunId?: unknown;
  [key: string]: unknown;
};

type LeanJobStatus = {
  _id: unknown;
  targetPageId?: string;
  status?: string;
  createdAt?: Date;
  completedAt?: Date;
  processingStartedAt?: Date;
  lastError?: string;
  failureReason?: string;
  errorCode?: string;
  result?: unknown;
  payload?: Record<string, unknown>;
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
    return "Legacy automation status detected. Please trigger Start Now again after redeploy.";
  }

  return value;
}

function isLegacyMessage(value?: string | null) {
  if (!value) return false;

  const normalized = value.toLowerCase();
  return (
    normalized.includes("n8n") ||
    normalized.includes("requested webhook") ||
    normalized.includes("workflow must be active") ||
    normalized.includes("webhook")
  );
}

function mapShopeeLastError(value?: string | null) {
  const message = sanitizeLegacyMessage(value);
  if (!message) return null;
  const storageMessage = mapStorageQuotaMessage(message);
  if (storageMessage) {
    return {
      source: "storage",
      status: 507,
      message: storageMessage
    };
  }
  const normalized = message.toLowerCase();
  if (normalized.includes("shopee") && (normalized.includes("401") || normalized.includes("rejected"))) {
    return {
      source: "shopee_api",
      status: 401,
      message: "Shopee rejected the request. Check partner ID, partner key, signature, timestamp, and region."
    };
  }
  if (normalized.includes("unauthorized")) {
    return {
      source: "internal_api",
      status: 401,
      message: "Internal Shopee API unauthorized. Check login/session or server route auth."
    };
  }
  return {
      source: "unknown",
      status: null,
      message
  };
}

function resolveResponseShape(value: unknown) {
  if (!value || typeof value !== "object") return "unknown";
  return Object.keys(value as Record<string, unknown>).join(".") || "object";
}

function normalizePageJobStatus(status?: string) {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "duplicate_blocked") return "skipped";
  if (status === "processing") return "publishing";
  if (status === "retrying" || status === "rate_limited") return "retrying";
  return "pending";
}

export async function GET() {
  try {
    const { requireAuth } = await import("@/lib/api");
    const userId = await requireAuth();
    console.info("[auto-post/control-panel] status fetch started", { userId });

    // This status endpoint is polled by the UI, so it must stay read-only.
    // MongoDB Atlas blocks all writes when storage quota is exceeded; even an
    // upsert/log write here would make the control panel fail to render.
    const configResult = await AutoPostConfig.findOne({ userId }).lean();

    const config = (configResult as AutoPostConfigStatusDoc | null) ?? null;
    const defaultConfig = {
      userId,
      enabled: false,
      contentSource: "shopee-affiliate",
      folderId: "root",
      folderName: "My Drive",
      shopeeSourceTag: "trending",
      shopeeKeyword: "",
      shopeeCategory: "",
      shopeeCaptionStyle: "soft_sell",
      shopeeTrackingId: "",
      shopeeBlockedCategories: [],
      shopeeCategoryPriority: [],
      targetPageIds: [],
      intervalMinutes: 60,
      captionStrategy: "hybrid",
      captions: [],
      hashtags: [],
      aiPrompt: "",
      postingWindowStart: "06:00",
      postingWindowEnd: "00:00",
      language: "th",
      autoPostStatus: "paused",
      jobStatus: "pending",
      retryCount: 0,
      lastError: null
    };
    const effectiveConfig = config ?? defaultConfig;
    const effectiveConfigDoc = effectiveConfig as AutoPostConfigStatusDoc & {
      targetPageIds?: string[];
      lastWorkflowRunId?: unknown;
      _id?: unknown;
    };

    const logs = await ActionLog.find({
      userId,
      "metadata.autoPost": true
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const legacyLastError = effectiveConfig?.lastError ?? null;
    const sanitizedLastError = sanitizeLegacyMessage(legacyLastError);
    const facebookConnection = await FacebookConnection.findOne({ userId }).lean();
    const facebookPages = Array.isArray((facebookConnection as any)?.pages) ? (facebookConnection as any).pages : [];
    const connectedPageCount = facebookPages.length;
    const pageNameById = new Map<string, string>(
      facebookPages.map((page: any) => [String(page.pageId ?? ""), String(page.name ?? page.pageName ?? "Facebook Page")])
    );
    const shopeeProvider = getShopeeProductProvider();
    const shopeeEnvStatus = getShopeeEnvStatus();
    const storage = await getStorageStatus();
    const lastProduct = await ShopeeProduct.findOne({}).sort({ fetchedAt: -1 }).select("fetchedAt").lean();
    const lastPublishedQueueItem = await FacebookPostQueue.findOne({ userId, status: "published" })
      .sort({ updatedAt: -1 })
      .select("updatedAt")
      .lean();
    const contentSource = String(effectiveConfig?.contentSource ?? "shopee-affiliate");
    const shopeeSourceReady = contentSource === "shopee-affiliate" && Boolean(effectiveConfig?.shopeeSourceTag);
    const facebookReady = connectedPageCount > 0;
    const affiliateStatus = getShopeeAffiliateConfigStatus(
      typeof effectiveConfig?.shopeeTrackingId === "string" ? effectiveConfig.shopeeTrackingId : ""
    );
    const targetPageIds = Array.isArray(effectiveConfigDoc?.targetPageIds) ? effectiveConfigDoc.targetPageIds : [];
    const workflowRunId = effectiveConfigDoc?.lastWorkflowRunId ? String(effectiveConfigDoc.lastWorkflowRunId) : null;
    const jobQuery: Record<string, unknown> = {
      userId,
      type: "post",
      "payload.autoSource": "shopee-affiliate"
    };
    if (workflowRunId) {
      jobQuery["payload.workflowRunId"] = workflowRunId;
    } else if (effectiveConfigDoc?._id) {
      jobQuery["payload.autoPostConfigId"] = String(effectiveConfigDoc._id);
    }

    const runJobs = (await Job.find(jobQuery)
      .sort({ createdAt: -1 })
      .limit(Math.max(100, targetPageIds.length || 30))
      .lean()) as LeanJobStatus[];
    const latestProcessingJob = runJobs.find((job) => job.status === "processing") ?? null;
    const latestFailedJob = runJobs.find((job) => job.status === "failed" || job.status === "duplicate_blocked") ?? null;
    const selectedPagesCount = Math.max(
      targetPageIds.length,
      runJobs.length,
      ...runJobs
        .map((job) => Number(job.payload?.selectedPagesCount ?? 0))
        .filter((value) => Number.isFinite(value))
    );
    const publishedPagesCount = runJobs.filter((job) => job.status === "success").length;
    const failedPagesCount = runJobs.filter((job) => job.status === "failed" || job.status === "duplicate_blocked").length;
    const pendingPagesCount = Math.max(0, selectedPagesCount - publishedPagesCount - failedPagesCount);
    const pageResults = runJobs
      .map((job) => ({
        jobId: String(job._id),
        pageId: String(job.targetPageId ?? ""),
        pageName: pageNameById.get(String(job.targetPageId ?? "")) ?? "Facebook Page",
        status: normalizePageJobStatus(job.status),
        rawStatus: job.status ?? "queued",
        facebookPostId: typeof (job.result as any)?.id === "string" ? (job.result as any).id : null,
        errorCode: job.errorCode ?? null,
        errorMessage: sanitizeLegacyMessage(job.failureReason ?? job.lastError ?? null),
        startedAt: job.processingStartedAt ?? job.createdAt ?? null,
        finishedAt: job.completedAt ?? null
      }))
      .reverse();
    const currentStep = latestProcessingJob
      ? "PAGE_PUBLISH_STARTED"
      : runJobs.length
        ? runJobs[0].status === "success"
          ? "PAGE_PUBLISH_SUCCESS"
          : runJobs[0].status === "failed"
            ? "PAGE_PUBLISH_FAILED"
            : "START_PUBLISH_TO_PAGES"
        : String(effectiveConfig?.autoPostStatus ?? "paused");
    const currentPublishingPage = latestProcessingJob
      ? {
          pageId: String(latestProcessingJob.targetPageId ?? ""),
          pageName: pageNameById.get(String(latestProcessingJob.targetPageId ?? "")) ?? "Facebook Page"
        }
      : null;
    const pageFailureMessage = latestFailedJob
      ? `${pageNameById.get(String(latestFailedJob.targetPageId ?? "")) ?? "Facebook Page"}: ${
          sanitizeLegacyMessage(latestFailedJob.failureReason ?? latestFailedJob.lastError ?? latestFailedJob.errorCode ?? "Publish failed")
        }`
      : null;
    const mappedLastError = pageFailureMessage
      ? { source: "facebook_api", status: null, message: pageFailureMessage }
      : mapShopeeLastError(sanitizedLastError);
    const affiliateMissingMessage = affiliateStatus.missing.length
      ? `Shopee Affiliate setup required. Missing: ${affiliateStatus.missing.join(", ")}`
      : null;
    const lastError =
      affiliateStatus.status === "setup_required"
        ? { source: "config", status: null, message: affiliateMissingMessage }
        : mappedLastError;
    const shopeeApiStatus =
      shopeeEnvStatus.providerMode === "mock"
        ? "mock"
        : shopeeEnvStatus.missing.length
          ? "missing_env"
          : affiliateStatus.status === "setup_required"
            ? "configured"
          : mappedLastError?.source === "shopee_api" && mappedLastError.status === 401
            ? "unauthorized"
            : mappedLastError?.source === "shopee_api"
              ? "error"
              : "configured";
    const missingEnv = [...shopeeEnvStatus.missing, ...affiliateStatus.missing];

    const controlPanel = {
      state: !shopeeSourceReady || affiliateStatus.status === "setup_required" ? "setup_required" : !facebookReady ? "facebook_required" : "ready",
      shopeeApiStatus,
      affiliateConfigStatus: affiliateStatus.status,
      facebookPageStatus: facebookReady ? "connected" : "missing",
      autoPostEngineStatus: affiliateStatus.status === "setup_required" ? "blocked_setup_required" : effectiveConfig?.autoPostStatus ?? "paused",
      lastProductFetchAt: (lastProduct as any)?.fetchedAt ?? null,
      lastPublishAt: (lastPublishedQueueItem as any)?.updatedAt ?? null,
      provider: shopeeProvider.name,
      connectedPageCount,
      currentJobId: latestProcessingJob ? String(latestProcessingJob._id) : runJobs[0]?._id ? String(runJobs[0]._id) : null,
      currentStep,
      selectedPagesCount,
      publishedPagesCount,
      failedPagesCount,
      pendingPagesCount,
      currentPublishingPage,
      pageResults,
      lastActivityAt: logs[0]?.createdAt ?? runJobs[0]?.createdAt ?? null,
      lastSuccessAt: runJobs.find((job) => job.status === "success")?.completedAt ?? null,
      missingEnv,
      env: {
        ok: shopeeEnvStatus.ok,
        missing: shopeeEnvStatus.missing,
        configured: shopeeEnvStatus.configured
      },
      lastError,
      storage,
      responseShape: {
        pages: "data.pages",
        status: "config.logs.controlPanel"
      }
    };

    const sanitizedConfig = {
      ...effectiveConfig,
      lastError: isLegacyMessage(legacyLastError) ? null : sanitizedLastError
    };

    const normalizedLogs = logs
      .filter((log) => {
        const message = String(log.message ?? "").toLowerCase();
        const metadata = (log.metadata ?? {}) as Record<string, unknown>;
        const source = String(metadata.source ?? "").toLowerCase();
        const destination = String(metadata.destination ?? "").toLowerCase();

        return !message.includes("n8n") && source !== "n8n" && destination !== "n8n";
      })
      .map((log) => ({
        _id: String(log._id),
        level: log.level,
        message: log.message,
        createdAt: log.createdAt,
        metadata: log.metadata ?? {}
      }));

    console.info("[auto-post/control-panel] status fetch completed", {
      userId,
      state: controlPanel.state,
      connectedPageCount,
      provider: shopeeProvider.name,
      shopeeApiStatus,
      missingEnv
    });

    return jsonOk({ config: sanitizedConfig, logs: normalizedLogs, controlPanel });
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return jsonError("Unauthorized", 401);
    }

    console.error("[auto-post/control-panel] status fetch failed", {
      message: error instanceof Error ? error.message : "Unknown error"
    });

    return jsonError(error instanceof Error ? error.message : "Unable to load auto-post status", 500);
  }
}
