import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { ActionLog } from "@/models/ActionLog";
import { FacebookConnection } from "@/models/FacebookConnection";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { Job } from "@/models/Job";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { getShopeeAffiliateConfigStatus, getShopeeEnvStatus, getShopeeProductProvider } from "@/lib/services/shopee-affiliate";
import { repairMissingShopeePageTasks } from "@/lib/services/queue";
import { getStorageStatus, mapStorageQuotaMessage } from "@/lib/services/storage-cleanup";
import { DEFAULT_SHOPEE_CATEGORY, normalizeShopeeCategories, normalizeShopeeCategory } from "@/lib/shopee-categories";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type AutoPostConfigStatusDoc = {
  _id: unknown;
  autoPostStatus?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  targetPageIds?: string[];
  lastWorkflowRunId?: unknown;
  postingWindowStart?: string | null;
  postingWindowEnd?: string | null;
  postingWindowCustomized?: boolean | null;
  [key: string]: unknown;
};

type LeanJobStatus = {
  _id: unknown;
  targetPageId?: string;
  status?: string;
  createdAt?: Date;
  nextRunAt?: Date;
  completedAt?: Date;
  processingStartedAt?: Date;
  lastError?: string;
  failureReason?: string;
  errorCode?: string;
  result?: unknown;
  payload?: Record<string, unknown>;
};

const STATUS_FAST_TIMEOUT_MS = Number(process.env.AUTO_POST_STATUS_FAST_TIMEOUT_MS ?? 1200);
const STATUS_OPTIONAL_TIMEOUT_MS = Number(process.env.AUTO_POST_STATUS_OPTIONAL_TIMEOUT_MS ?? 1500);
const STATUS_JOB_TIMEOUT_MS = Number(process.env.AUTO_POST_STATUS_JOB_TIMEOUT_MS ?? 1800);
const STATUS_REPAIR_TIMEOUT_MS = Number(process.env.AUTO_POST_STATUS_REPAIR_TIMEOUT_MS ?? 6000);
const AUTO_POST_STATUS_PRE_TASK_TIMEOUT_MS = Number(process.env.AUTO_POST_JOB_TIMEOUT_MS ?? 300000);

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
  if (status === "queued") return "queued";
  if (status === "retrying" || status === "rate_limited") return "retrying";
  return "pending";
}

function storageStatusFallback() {
  const limitMb = Number(process.env.MONGODB_STORAGE_LIMIT_MB ?? process.env.STORAGE_LIMIT_MB ?? 512);
  const limitBytes = Number.isFinite(limitMb) && limitMb > 0 ? limitMb * 1024 * 1024 : 512 * 1024 * 1024;

  return {
    enabled: process.env.STORAGE_CLEANUP_ENABLED !== "false",
    usedBytes: 0,
    dataBytes: 0,
    storageBytes: 0,
    indexBytes: 0,
    limitBytes,
    percent: 0,
    warningThresholdPercent: Number(process.env.STORAGE_WARNING_THRESHOLD_PERCENT ?? 85),
    criticalThresholdPercent: Number(process.env.STORAGE_CRITICAL_THRESHOLD_PERCENT ?? 95),
    status: "ok" as const,
    lastCleanup: null,
    collections: [],
    warning: "storage_status_timeout"
  };
}

async function withSoftTimeout<T>(task: Promise<T>, timeoutMs: number, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    task.catch((error) => {
      console.warn("[auto-post/control-panel] optional status task failed", {
        label,
        message: error instanceof Error ? error.message : "Unknown error"
      });
      return fallback;
    }),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        console.warn("[auto-post/control-panel] optional status task timed out", {
          label,
          timeoutMs
        });
        resolve(fallback);
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const DEFAULT_POSTING_WINDOW_START = "00:00";
const DEFAULT_POSTING_WINDOW_END = "23:59";
const LEGACY_POSTING_WINDOW_START = "06:00";
const LEGACY_POSTING_WINDOW_END = "00:00";

function normalizePostingWindowForDisplay<T extends { postingWindowStart?: string | null; postingWindowEnd?: string | null; postingWindowCustomized?: boolean | null }>(config: T): T {
  if (
    config.postingWindowCustomized !== true &&
    config.postingWindowStart === LEGACY_POSTING_WINDOW_START &&
    config.postingWindowEnd === LEGACY_POSTING_WINDOW_END
  ) {
    return {
      ...config,
      postingWindowStart: DEFAULT_POSTING_WINDOW_START,
      postingWindowEnd: DEFAULT_POSTING_WINDOW_END,
      postingWindowCustomized: false
    };
  }

  return config;
}

export async function GET() {
  try {
    const { requireAuth } = await import("@/lib/api");
    const userId = await requireAuth();
    console.info("[auto-post/control-panel] status fetch started", { userId });

    // This status endpoint is polled by the UI, so it must stay read-only.
    // MongoDB Atlas blocks all writes when storage quota is exceeded; even an
    // upsert/log write here would make the control panel fail to render.
    const configResult = await withSoftTimeout(
      AutoPostConfig.findOne({ userId })
        .maxTimeMS(STATUS_FAST_TIMEOUT_MS)
        .lean()
        .exec(),
      STATUS_FAST_TIMEOUT_MS + 400,
      null,
      "auto-post-config"
    );

    const config = (configResult as AutoPostConfigStatusDoc | null) ?? null;
    const defaultConfig = {
      userId,
      enabled: false,
      contentSource: "shopee-affiliate",
      folderId: "root",
      folderName: "My Drive",
      shopeeSourceTag: "trending",
      shopeeKeyword: "",
      shopeeCategory: DEFAULT_SHOPEE_CATEGORY,
      shopeeCategories: [],
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
      postingWindowStart: DEFAULT_POSTING_WINDOW_START,
      postingWindowEnd: DEFAULT_POSTING_WINDOW_END,
      postingWindowCustomized: false,
      language: "th",
      autoPostStatus: "paused",
      jobStatus: "pending",
      retryCount: 0,
      lastError: null
    };
    const effectiveConfig = normalizePostingWindowForDisplay(config ?? defaultConfig);
    if (typeof (effectiveConfig as Record<string, unknown>).shopeeCategory === "string") {
      (effectiveConfig as Record<string, unknown>).shopeeCategory = normalizeShopeeCategory(
        (effectiveConfig as Record<string, unknown>).shopeeCategory as string
      );
    }
    (effectiveConfig as Record<string, unknown>).shopeeCategories = normalizeShopeeCategories(
      Array.isArray((effectiveConfig as Record<string, unknown>).shopeeCategories)
        ? ((effectiveConfig as Record<string, unknown>).shopeeCategories as string[])
        : ((effectiveConfig as Record<string, unknown>).shopeeCategory as string | undefined)
    );
    (effectiveConfig as Record<string, unknown>).shopeeCategory =
      ((effectiveConfig as Record<string, unknown>).shopeeCategories as string[])[0] ?? DEFAULT_SHOPEE_CATEGORY;
    const effectiveConfigDoc = effectiveConfig as AutoPostConfigStatusDoc & {
      targetPageIds?: string[];
      lastWorkflowRunId?: unknown;
      _id?: unknown;
    };

    const logsPromise = withSoftTimeout(
      ActionLog.find({
        userId,
        "metadata.autoPost": true
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("level message createdAt metadata")
        .maxTimeMS(STATUS_OPTIONAL_TIMEOUT_MS)
        .lean()
        .exec(),
      STATUS_OPTIONAL_TIMEOUT_MS,
      [],
      "activity-logs"
    );

    const legacyLastError = effectiveConfig?.lastError ?? null;
    const sanitizedLastError = sanitizeLegacyMessage(legacyLastError);
    const facebookConnectionPromise = withSoftTimeout(
      FacebookConnection.findOne({ userId })
        .select("pages.pageId pages.id pages.externalPageId pages.name pages.pageName pages.pageAccessToken tokenStatus")
        .maxTimeMS(STATUS_OPTIONAL_TIMEOUT_MS)
        .lean()
        .exec(),
      STATUS_OPTIONAL_TIMEOUT_MS,
      null,
      "facebook-connection"
    );
    const storagePromise = withSoftTimeout(getStorageStatus(), STATUS_OPTIONAL_TIMEOUT_MS, storageStatusFallback(), "storage-status");
    const lastProductPromise = withSoftTimeout(
      ShopeeProduct.findOne({}).sort({ fetchedAt: -1 }).select("fetchedAt").maxTimeMS(STATUS_FAST_TIMEOUT_MS).lean().exec(),
      STATUS_FAST_TIMEOUT_MS,
      null,
      "last-product"
    );
    const lastPublishedQueueItemPromise = withSoftTimeout(
      FacebookPostQueue.findOne({ userId, status: "published" })
        .sort({ updatedAt: -1 })
        .select("updatedAt")
        .maxTimeMS(STATUS_FAST_TIMEOUT_MS)
        .lean()
        .exec(),
      STATUS_FAST_TIMEOUT_MS,
      null,
      "last-published"
    );
    const [logs, facebookConnection, storage, lastProduct, lastPublishedQueueItem] = await Promise.all([
      logsPromise,
      facebookConnectionPromise,
      storagePromise,
      lastProductPromise,
      lastPublishedQueueItemPromise
    ]);
    const facebookPages = Array.isArray((facebookConnection as any)?.pages) ? (facebookConnection as any).pages : [];
    const connectedPageCount = facebookPages.length;
    const pageNameById = new Map<string, string>(
      facebookPages.map((page: any) => [String(page.pageId ?? ""), String(page.name ?? page.pageName ?? "Facebook Page")])
    );
    const shopeeProvider = getShopeeProductProvider();
    const shopeeEnvStatus = getShopeeEnvStatus();
    const contentSource = String(effectiveConfig?.contentSource ?? "shopee-affiliate");
    const shopeeSourceReady = contentSource === "shopee-affiliate" && Boolean(effectiveConfig?.shopeeSourceTag);
    const facebookReady = connectedPageCount > 0;
    const affiliateStatus = getShopeeAffiliateConfigStatus(
      typeof effectiveConfig?.shopeeTrackingId === "string" ? effectiveConfig.shopeeTrackingId : ""
    );
    const targetPageIds = Array.isArray(effectiveConfigDoc?.targetPageIds) ? effectiveConfigDoc.targetPageIds : [];
    const workflowRunId = effectiveConfigDoc?.lastWorkflowRunId ? String(effectiveConfigDoc.lastWorkflowRunId) : null;
    const shouldAutoRepairMissingTasks =
      effectiveConfigDoc?._id &&
      contentSource === "shopee-affiliate" &&
      targetPageIds.length > 0 &&
      ["posting", "waiting"].includes(String(effectiveConfigDoc.autoPostStatus ?? effectiveConfig?.autoPostStatus ?? ""));

    const repairedTasks = shouldAutoRepairMissingTasks
      ? await withSoftTimeout(
          repairMissingShopeePageTasks(userId, effectiveConfigDoc as Record<string, any>, workflowRunId),
          STATUS_REPAIR_TIMEOUT_MS,
          { created: 0, expected: targetPageIds.length },
          "repair-missing-shopee-page-tasks"
        )
      : { created: 0, expected: targetPageIds.length };

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

    const runJobs = (await withSoftTimeout(
      Job.find(jobQuery)
        .sort({ createdAt: -1 })
        .limit(Math.max(40, targetPageIds.length * 3 || 20))
        .select("_id targetPageId status createdAt nextRunAt completedAt processingStartedAt lastError failureReason errorCode result payload")
        .maxTimeMS(STATUS_JOB_TIMEOUT_MS)
        .lean()
        .exec(),
      STATUS_JOB_TIMEOUT_MS,
      [],
      "publish-jobs"
    )) as LeanJobStatus[];
    const lastRunAtDate =
      effectiveConfigDoc?.lastRunAt instanceof Date
        ? effectiveConfigDoc.lastRunAt
        : effectiveConfigDoc?.lastRunAt
          ? new Date(String(effectiveConfigDoc.lastRunAt))
          : null;
    const autoPostEngineStatus = String(effectiveConfigDoc.autoPostStatus ?? effectiveConfig?.autoPostStatus ?? "");
    const latestRunLog = logs.find((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      return workflowRunId ? String(metadata.workflowRunId ?? "") === workflowRunId : true;
    });
    const latestRunLogAt =
      latestRunLog?.createdAt instanceof Date
        ? latestRunLog.createdAt
        : latestRunLog?.createdAt
          ? new Date(String(latestRunLog.createdAt))
          : null;
    const preTaskReferenceAt =
      latestRunLogAt instanceof Date && !Number.isNaN(latestRunLogAt.getTime())
        ? latestRunLogAt
        : lastRunAtDate;
    const preTaskAgeMs =
      preTaskReferenceAt instanceof Date && !Number.isNaN(preTaskReferenceAt.getTime())
        ? Date.now() - preTaskReferenceAt.getTime()
        : 0;
    const noTaskRunIsActive =
      runJobs.length === 0 &&
      ["running", "retrying"].includes(autoPostEngineStatus) &&
      preTaskAgeMs <= AUTO_POST_STATUS_PRE_TASK_TIMEOUT_MS;
    const noTaskRunIsStale =
      runJobs.length === 0 &&
      lastRunAtDate instanceof Date &&
      !Number.isNaN(lastRunAtDate.getTime()) &&
      !noTaskRunIsActive &&
      (["failed", "stopped", "paused"].includes(autoPostEngineStatus) ||
        Date.now() - lastRunAtDate.getTime() > AUTO_POST_STATUS_PRE_TASK_TIMEOUT_MS);
    const latestProcessingJob = runJobs.find((job) => job.status === "processing") ?? null;
    const latestFailedJob = runJobs.find((job) => job.status === "failed" || job.status === "duplicate_blocked") ?? null;
    const uniqueTargetPageIds = Array.from(new Set(targetPageIds.map((pageId) => String(pageId)).filter(Boolean)));
    const jobByPageId = new Map<string, LeanJobStatus>();
    for (const job of runJobs) {
      const pageId = String(job.targetPageId ?? "");
      if (pageId && !jobByPageId.has(pageId)) {
        jobByPageId.set(pageId, job);
      }
    }
    const pageIdsForResults =
      uniqueTargetPageIds.length > 0
        ? uniqueTargetPageIds
        : Array.from(jobByPageId.keys());
    const pageResults = pageIdsForResults.map((pageId) => {
      const job = jobByPageId.get(pageId);
      if (!job) {
        return {
          jobId: null,
          pageId,
          pageName: pageNameById.get(pageId) ?? "Facebook Page",
          shortAffiliateLink: null,
          status: "pending",
          rawStatus: "not_created",
          facebookPostId: null,
          errorCode: null,
          errorMessage: noTaskRunIsStale
            ? "No template post/page task exists for the latest run. Start Now to retry."
            : "Preparing Shopee post package before page tasks are created",
          startedAt: null,
          scheduledAt: null,
          finishedAt: null
        };
      }
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const normalizedStatus = normalizePageJobStatus(job.status);
      const scheduledAt = job.nextRunAt ?? null;
      const isFutureQueued =
        (job.status === "queued" || normalizedStatus === "queued") &&
        scheduledAt instanceof Date &&
        scheduledAt.getTime() > Date.now();

      return {
        jobId: String(job._id),
        pageId,
        pageName: pageNameById.get(pageId) ?? "Facebook Page",
        shortAffiliateLink:
          typeof payload.affiliateLink === "string"
            ? payload.affiliateLink
            : typeof payload.shortAffiliateLink === "string"
              ? payload.shortAffiliateLink
              : null,
        status: isFutureQueued ? "waiting" : normalizedStatus,
        rawStatus: job.status ?? "queued",
        facebookPostId: typeof (job.result as any)?.id === "string" ? (job.result as any).id : null,
        errorCode: job.errorCode ?? null,
        errorMessage: isFutureQueued ? null : sanitizeLegacyMessage(job.failureReason ?? job.lastError ?? null),
        startedAt: job.processingStartedAt ?? job.createdAt ?? null,
        scheduledAt,
        finishedAt: job.completedAt ?? null
      };
    });
    const selectedPagesCount = pageResults.length;
    const publishedPagesCount = pageResults.filter((page) => page.status === "success").length;
    const failedPagesCount = pageResults.filter((page) => page.status === "failed" || page.status === "skipped").length;
    const activePagesCount = pageResults.filter((page) => page.status === "publishing" || page.status === "retrying").length;
    const pendingPagesCount = Math.max(0, selectedPagesCount - publishedPagesCount - failedPagesCount - activePagesCount);
    const createdTasksCount = pageResults.filter((page) => page.jobId).length;
    const missingTasksCount = Math.max(0, selectedPagesCount - createdTasksCount);
    const latestRunStep = String(((latestRunLog?.metadata ?? {}) as Record<string, unknown>).step ?? "");
    const currentStep = noTaskRunIsActive
      ? latestRunStep || "PREPARING_SHOPEE_POST_PACKAGE"
      : latestProcessingJob
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
    const latestAttemptLog = logs.find((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      return (
        metadata.step === "PRODUCT_ATTEMPT_STARTED" ||
        metadata.step === "PRODUCT_ATTEMPT_FAILED" ||
        metadata.step === "PRODUCT_ATTEMPT_SUCCESS" ||
        metadata.step === "PRODUCT_SKIPPED" ||
        metadata.step === "RETRYING_WITH_NEXT_PRODUCT"
      );
    });
    const latestSkippedProductLog = logs.find((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      const step = String(metadata.step ?? "");
      return step === "PRODUCT_SKIPPED" || step.startsWith("PRODUCT_SKIPPED_");
    });
    const latestAttemptMetadata = (latestAttemptLog?.metadata ?? {}) as Record<string, unknown>;
    const latestSkippedMetadata = (latestSkippedProductLog?.metadata ?? {}) as Record<string, unknown>;
    const currentAttempt =
      typeof latestAttemptMetadata.attempt === "number" ? latestAttemptMetadata.attempt : latestAttemptMetadata.attempt ? Number(latestAttemptMetadata.attempt) : null;
    const maxProductAttempts =
      typeof latestAttemptMetadata.maxAttempts === "number"
        ? latestAttemptMetadata.maxAttempts
        : Number(process.env.AUTO_POST_MAX_PRODUCT_ATTEMPTS ?? 10);
    const skippedProductsCount =
      typeof latestAttemptMetadata.skippedProductsCount === "number"
        ? latestAttemptMetadata.skippedProductsCount
        : typeof latestSkippedMetadata.skippedProductsCount === "number"
          ? latestSkippedMetadata.skippedProductsCount
          : logs.filter((log) => {
              const step = String(((log.metadata ?? {}) as Record<string, unknown>).step ?? "");
              return step === "PRODUCT_SKIPPED" || step.startsWith("PRODUCT_SKIPPED_");
            }).length;
    const latestAttemptStep = String(latestAttemptMetadata.step ?? "");
    const isFindingValidProduct =
      !latestProcessingJob &&
      missingTasksCount > 0 &&
      createdTasksCount === 0 &&
      currentAttempt !== null &&
      latestAttemptStep !== "PRODUCT_ATTEMPT_SUCCESS" &&
      latestAttemptStep !== "MAX_PRODUCT_ATTEMPTS_REACHED" &&
      String(effectiveConfig?.autoPostStatus ?? "").match(/running|retrying/i);
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
      facebookPages: facebookPages.map((page: any) => ({
        pageId: String(page.pageId ?? page.id ?? page.externalPageId ?? ""),
        name: String(page.name ?? page.pageName ?? "Facebook Page")
      })).filter((page: { pageId: string; name: string }) => page.pageId.length > 0),
      currentJobId: latestProcessingJob ? String(latestProcessingJob._id) : runJobs[0]?._id ? String(runJobs[0]._id) : null,
      currentStep: isFindingValidProduct ? "FINDING_VALID_PRODUCT" : noTaskRunIsStale ? "WAITING_FOR_TEMPLATE_POST" : currentStep,
      currentAttempt,
      maxProductAttempts,
      skippedProductsCount,
      currentProduct: latestAttemptMetadata.productName ? String(latestAttemptMetadata.productName) : null,
      lastSkippedReason: latestSkippedProductLog
        ? sanitizeLegacyMessage(String(latestSkippedMetadata.reason ?? latestSkippedProductLog.message ?? "Product skipped"))
        : null,
      selectedPagesCount,
      createdTasksCount,
      queueHealth: isFindingValidProduct ? "finding_valid_product" : noTaskRunIsActive ? "preparing_page_tasks" : noTaskRunIsStale ? "waiting_for_template_post" : missingTasksCount > 0 ? "missing_tasks" : "ok",
      missingTasksCount: isFindingValidProduct ? 0 : missingTasksCount,
      missingTasksWarning: isFindingValidProduct
        ? null
        : noTaskRunIsActive
        ? null
        : noTaskRunIsStale
        ? `No template post/page task exists for the latest run. Expected: ${selectedPagesCount}, Created: ${createdTasksCount}. Start Now to retry.`
        : missingTasksCount > 0
        ? `Missing Tasks Detected. Expected: ${selectedPagesCount}, Created: ${createdTasksCount}`
        : null,
      repairedTasksCount: repairedTasks.created,
      publishedPagesCount,
      failedPagesCount,
      pendingPagesCount,
      currentPublishingPage,
      pageResults,
      lastActivityAt: logs[0]?.createdAt ?? runJobs[0]?.createdAt ?? null,
      lastWorkerHeartbeat: latestProcessingJob?.processingStartedAt ?? logs[0]?.createdAt ?? runJobs[0]?.createdAt ?? null,
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
