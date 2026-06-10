import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { ActionLog } from "@/models/ActionLog";
import { FacebookConnection } from "@/models/FacebookConnection";
import { Job } from "@/models/Job";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { getShopeeAffiliateConfigStatus, getShopeeEnvStatus, getShopeeProductProvider } from "@/lib/services/shopee-affiliate";
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
  postId?: unknown;
  targetPageId?: string;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
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

type StageLog = {
  message?: unknown;
  createdAt?: unknown;
  metadata?: Record<string, unknown>;
};

function getStageStep(log: StageLog) {
  return String((log.metadata ?? {}).step ?? "");
}

function getLatestStageLog(logs: StageLog[], steps: string[]) {
  const stepSet = new Set(steps);
  return logs.find((log) => stepSet.has(getStageStep(log))) ?? null;
}

function isStageLogOlderThan(log: StageLog | null, staleAfterMs: number) {
  if (!log?.createdAt) return false;
  const createdAtMs = new Date(String(log.createdAt)).getTime();
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs > staleAfterMs;
}

function getStageStatusSummary(logs: StageLog[], input: {
  started: string[];
  completed: string[];
  failed: string[];
  staleStartedAfterMs?: number;
}) {
  const latest = getLatestStageLog(logs, [...input.failed, ...input.completed, ...input.started]);
  if (!latest) return "pending";
  const latestStep = getStageStep(latest);
  if (input.failed.includes(latestStep)) return "failed";
  if (input.completed.includes(latestStep)) return "created";
  if (input.started.includes(latestStep)) {
    if (input.staleStartedAfterMs && isStageLogOlderThan(latest, input.staleStartedAfterMs)) {
      return "failed";
    }
    return "started";
  }
  return "pending";
}

function getStageStatusSource(logs: StageLog[], input: {
  started: string[];
  completed: string[];
  failed: string[];
}) {
  const latest = getLatestStageLog(logs, [...input.failed, ...input.completed, ...input.started]);
  if (!latest) return "action_log:none";
  return `action_log:${getStageStep(latest) || "unknown"}`;
}

function getMetadataString(metadata: Record<string, unknown>, key: string) {
  return typeof metadata[key] === "string" ? String(metadata[key]) : null;
}

function getSerializedErrorMetadata(metadata: Record<string, unknown>) {
  return metadata.serializedError && typeof metadata.serializedError === "object"
    ? (metadata.serializedError as Record<string, unknown>)
    : null;
}

function getStageFailureDetails(log: StageLog | null, fallback?: { source?: string; reason?: string }) {
  if (!log) {
    return {
      step: null,
      source: fallback?.source ?? null,
      reason: fallback?.reason ?? null,
      stack: null
    };
  }

  const metadata = (log.metadata ?? {}) as Record<string, unknown>;
  const serializedError = getSerializedErrorMetadata(metadata);
  const reason =
    getMetadataString(metadata, "reason") ??
    getMetadataString(metadata, "errorMessage") ??
    (typeof serializedError?.message === "string" ? serializedError.message : null) ??
    (typeof log.message === "string" ? log.message : null) ??
    fallback?.reason ??
    null;
  const stack =
    getMetadataString(metadata, "stack") ??
    (typeof serializedError?.stack === "string" ? serializedError.stack : null);

  return {
    step: getStageStep(log),
    source: getMetadataString(metadata, "source") ?? fallback?.source ?? null,
    reason,
    stack
  };
}

function derivePreTaskBlockingStep(logs: StageLog[]) {
  const allRelevantSteps = [
    "TEMPLATE_POST_CREATED",
    "TEMPLATE_POST_CREATE_STARTED",
    "TEMPLATE_POST_CREATE_FAILED",
    "UGC_IMAGES_CREATED",
    "UGC_IMAGES_STARTED",
    "UGC_IMAGES_FAILED",
    "OPENAI_IMAGE_REQUEST_END",
    "OPENAI_IMAGE_REQUEST_START",
    "OPENAI_IMAGE_REQUEST_FAILED",
    "OPENAI_IMAGE_TIMEOUT",
    "BLOB_UPLOAD_COMPLETED",
    "BLOB_UPLOAD_STARTED",
    "BLOB_UPLOAD_FAILED",
    "CAPTION_CREATED",
    "CAPTION_FALLBACK_USED",
    "CAPTION_STARTED",
    "CAPTION_FAILED",
    "PRODUCT_CONTEXT_CREATE_COMPLETED",
    "PRODUCT_CONTEXT_CREATE_STARTED",
    "PRODUCT_CONTEXT_CREATE_FAILED",
    "PRODUCT_PACKAGE_LOOP_COMPLETED",
    "PRODUCT_PACKAGE_LOOP_STARTED",
    "PRODUCT_PACKAGE_LOOP_ITEM_COMPLETED",
    "PRODUCT_PACKAGE_LOOP_ITEM_STARTED",
    "PRODUCT_PACKAGE_LOOP_ITEM_FAILED",
    "STORYBOARD_CREATED",
    "OPENAI_STORYBOARD_REQUEST_END",
    "OPENAI_STORYBOARD_REQUEST_START",
    "OPENAI_STORYBOARD_REQUEST_FAILED",
    "OPENAI_STORYBOARD_REQUEST_TIMEOUT",
    "STORYBOARD_TIMEOUT",
    "STORYBOARD_RETRYING",
    "STORYBOARD_STARTED",
    "STORYBOARD_FAILED",
    "STORYBOARD_INPUT_READY",
    "PRODUCT_VALIDATION_PASSED",
    "PRODUCT_VALIDATION_STARTED",
    "PRODUCT_VALIDATION_FAILED",
    "PRODUCT_TITLE_CLEANED",
    "PRODUCT_FETCHED",
    "PRODUCT_FETCH_STARTED",
    "PRODUCT_FETCH_FAILED",
    "PRODUCT_SELECTED",
    "PRODUCT_ATTEMPT_STARTED"
  ];
  const latestRelevant = getLatestStageLog(logs, allRelevantSteps);
  const latestStep = latestRelevant ? getStageStep(latestRelevant) : "";
  if (
    [
      "TEMPLATE_POST_CREATE_FAILED",
      "BLOB_UPLOAD_FAILED",
      "UGC_IMAGES_FAILED",
      "OPENAI_IMAGE_REQUEST_FAILED",
      "OPENAI_IMAGE_TIMEOUT",
      "CAPTION_FAILED",
      "PRODUCT_CONTEXT_CREATE_FAILED",
      "PRODUCT_PACKAGE_LOOP_ITEM_FAILED",
      "STORYBOARD_FAILED",
      "STORYBOARD_TIMEOUT",
      "OPENAI_STORYBOARD_REQUEST_FAILED",
      "OPENAI_STORYBOARD_REQUEST_TIMEOUT",
      "PRODUCT_FETCH_FAILED"
    ].includes(latestStep)
  ) {
    return latestStep;
  }

  if (latestStep === "TEMPLATE_POST_CREATED") return "WAITING_FOR_PAGE_TASKS";
  if (latestStep === "TEMPLATE_POST_CREATE_STARTED") return "WAITING_FOR_TEMPLATE_POST";
  if (latestStep === "UGC_IMAGES_CREATED") return "WAITING_FOR_TEMPLATE_POST";
  if (latestStep === "OPENAI_IMAGE_REQUEST_END") {
    return isStageLogOlderThan(latestRelevant, 120_000) ? "BLOB_UPLOAD_TIMEOUT" : "WAITING_FOR_BLOB_UPLOAD";
  }
  if (latestStep === "OPENAI_IMAGE_REQUEST_START") {
    return isStageLogOlderThan(latestRelevant, 195_000) ? "OPENAI_IMAGE_TIMEOUT" : "WAITING_FOR_OPENAI_IMAGE";
  }
  if (latestStep === "UGC_IMAGES_STARTED") return "WAITING_FOR_UGC_IMAGES";
  if (latestStep === "BLOB_UPLOAD_STARTED") return "WAITING_FOR_BLOB_UPLOAD";
  if (latestStep === "BLOB_UPLOAD_COMPLETED") return "WAITING_FOR_UGC_IMAGES";
  if (latestStep === "CAPTION_CREATED" || latestStep === "CAPTION_FALLBACK_USED") return "WAITING_FOR_UGC_IMAGES";
  if (latestStep === "CAPTION_STARTED") return "WAITING_FOR_CAPTION";
  if (latestStep === "PRODUCT_CONTEXT_CREATE_STARTED") return "WAITING_FOR_PRODUCT_CONTEXT";
  if (latestStep === "PRODUCT_CONTEXT_CREATE_COMPLETED") return "WAITING_FOR_CAPTION";
  if (latestStep === "PRODUCT_PACKAGE_LOOP_STARTED") return "WAITING_FOR_PACKAGE_CREATION";
  if (latestStep === "PRODUCT_PACKAGE_LOOP_ITEM_STARTED") return "WAITING_FOR_PRODUCT_CONTEXT";
  if (latestStep === "PRODUCT_PACKAGE_LOOP_ITEM_COMPLETED") return "WAITING_FOR_PAGE_TASKS";
  if (latestStep === "STORYBOARD_CREATED") return "WAITING_FOR_CAPTION";
  if (latestStep === "OPENAI_STORYBOARD_REQUEST_END") return "WAITING_FOR_CAPTION";
  if (latestStep === "OPENAI_STORYBOARD_REQUEST_START" || latestStep === "STORYBOARD_RETRYING") return "WAITING_FOR_STORYBOARD";
  if (latestStep === "STORYBOARD_STARTED") return "WAITING_FOR_STORYBOARD";
  if (latestStep === "STORYBOARD_INPUT_READY" || latestStep === "PRODUCT_VALIDATION_PASSED") return "WAITING_FOR_STORYBOARD";
  if (latestStep === "PRODUCT_VALIDATION_STARTED" || latestStep === "PRODUCT_TITLE_CLEANED") return "WAITING_FOR_PRODUCT_VALIDATION";
  if (latestStep === "PRODUCT_FETCH_STARTED") return "WAITING_FOR_PRODUCT";
  if (
    latestStep === "PRODUCT_FETCHED" ||
    latestStep === "PRODUCT_SELECTED" ||
    latestStep === "PRODUCT_ATTEMPT_STARTED"
  ) {
    return "WAITING_FOR_STORYBOARD";
  }

  return "WAITING_FOR_PRODUCT";
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
    const targetPageIds = Array.isArray(effectiveConfigDoc?.targetPageIds) ? effectiveConfigDoc.targetPageIds : [];
    const workflowRunId = effectiveConfigDoc?.lastWorkflowRunId ? String(effectiveConfigDoc.lastWorkflowRunId) : null;
    const lastRunAtDate =
      effectiveConfigDoc?.lastRunAt instanceof Date
        ? effectiveConfigDoc.lastRunAt
        : effectiveConfigDoc?.lastRunAt
          ? new Date(String(effectiveConfigDoc.lastRunAt))
          : null;

    const actionLogQuery: Record<string, unknown> = {
      userId,
      $or: [
        { "metadata.autoPost": true },
        { "metadata.shopeeAffiliate": true }
      ]
    };
    if (workflowRunId) {
      actionLogQuery["metadata.workflowRunId"] = workflowRunId;
    } else if (lastRunAtDate instanceof Date && !Number.isNaN(lastRunAtDate.getTime())) {
      actionLogQuery.createdAt = { $gte: lastRunAtDate };
    }

    const logsPromise = withSoftTimeout(
      ActionLog.find(actionLogQuery)
        .sort({ createdAt: -1 })
        .limit(80)
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
    const [logs, facebookConnection, storage, lastProduct] = await Promise.all([
      logsPromise,
      facebookConnectionPromise,
      storagePromise,
      lastProductPromise
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
    const repairedTasks = { created: 0, expected: targetPageIds.length };

    const jobQuery: Record<string, unknown> = {
      userId,
      type: "post",
      "payload.autoSource": "shopee-affiliate"
    };
    if (workflowRunId) {
      jobQuery["payload.workflowRunId"] = workflowRunId;
    } else if (effectiveConfigDoc?._id) {
      jobQuery["payload.autoPostConfigId"] = String(effectiveConfigDoc._id);
      if (lastRunAtDate instanceof Date && !Number.isNaN(lastRunAtDate.getTime())) {
        jobQuery.createdAt = { $gte: lastRunAtDate };
      }
    }

    const runJobs = (await withSoftTimeout(
      Job.find(jobQuery)
        .sort({ createdAt: -1 })
        .limit(Math.max(40, targetPageIds.length * 3 || 20))
        .select("_id postId targetPageId status createdAt updatedAt nextRunAt completedAt processingStartedAt lastError failureReason errorCode result payload")
        .maxTimeMS(STATUS_JOB_TIMEOUT_MS)
        .lean()
        .exec(),
      STATUS_JOB_TIMEOUT_MS,
      [],
      "publish-jobs"
    )) as LeanJobStatus[];
    const autoPostEngineStatus = String(effectiveConfigDoc.autoPostStatus ?? effectiveConfig?.autoPostStatus ?? "");
    const latestRunLog = logs.find((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      return workflowRunId ? String(metadata.workflowRunId ?? "") === workflowRunId : true;
    });
    const runStageLogs = logs.filter((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      return workflowRunId ? String(metadata.workflowRunId ?? metadata.jobId ?? "") === workflowRunId : true;
    }) as StageLog[];
    const productStageLog = getLatestStageLog(runStageLogs, [
      "PRODUCT_ATTEMPT_STARTED",
      "PRODUCT_SELECTED",
      "PRODUCT_FETCHED",
      "STORYBOARD_STARTED",
      "STORYBOARD_CREATED",
      "OPENAI_STORYBOARD_REQUEST_START",
      "OPENAI_STORYBOARD_REQUEST_END",
      "OPENAI_STORYBOARD_REQUEST_FAILED",
      "OPENAI_STORYBOARD_REQUEST_TIMEOUT",
      "STORYBOARD_TIMEOUT",
      "STORYBOARD_RETRYING",
      "STORYBOARD_INPUT_READY",
      "PRODUCT_VALIDATION_STARTED",
      "PRODUCT_VALIDATION_PASSED",
      "PRODUCT_TITLE_CLEANED",
      "PRODUCT_CONTEXT_CREATE_STARTED",
      "PRODUCT_CONTEXT_CREATE_COMPLETED",
      "PRODUCT_CONTEXT_CREATE_FAILED",
      "PRODUCT_PACKAGE_LOOP_STARTED",
      "PRODUCT_PACKAGE_LOOP_COMPLETED",
      "PRODUCT_PACKAGE_LOOP_ITEM_STARTED",
      "PRODUCT_PACKAGE_LOOP_ITEM_COMPLETED",
      "PRODUCT_PACKAGE_LOOP_ITEM_FAILED",
      "CAPTION_STARTED",
      "CAPTION_CREATED",
      "CAPTION_FALLBACK_USED",
      "UGC_IMAGES_STARTED",
      "UGC_IMAGES_CREATED",
      "OPENAI_IMAGE_REQUEST_START",
      "OPENAI_IMAGE_REQUEST_END",
      "OPENAI_IMAGE_REQUEST_FAILED",
      "OPENAI_IMAGE_TIMEOUT",
      "TEMPLATE_POST_CREATE_STARTED",
      "TEMPLATE_POST_CREATED"
    ]);
    const productStageMetadata = (productStageLog?.metadata ?? {}) as Record<string, unknown>;
    const templatePostLog = getLatestStageLog(runStageLogs, ["TEMPLATE_POST_CREATED", "TEMPLATE_POST_RESULT"]);
    const templatePostMetadata = (templatePostLog?.metadata ?? {}) as Record<string, unknown>;
    const preTaskBlockingStep = derivePreTaskBlockingStep(runStageLogs);
    const storyboardStatusInput = {
      started: ["STORYBOARD_STARTED", "OPENAI_STORYBOARD_REQUEST_START", "STORYBOARD_RETRYING"],
      completed: ["STORYBOARD_CREATED", "OPENAI_STORYBOARD_REQUEST_END"],
      failed: ["STORYBOARD_FAILED", "STORYBOARD_TIMEOUT", "OPENAI_STORYBOARD_REQUEST_FAILED", "OPENAI_STORYBOARD_REQUEST_TIMEOUT"]
    };
    const captionStatusInput = {
      started: ["CAPTION_STARTED"],
      completed: ["CAPTION_CREATED", "CAPTION_FALLBACK_USED"],
      failed: ["CAPTION_FAILED", "CAPTION_VALIDATION_FAILED_DETAIL"],
      staleStartedAfterMs: 120_000
    };
    const imageStatusInput = {
      started: ["UGC_IMAGES_STARTED", "OPENAI_IMAGE_REQUEST_START"],
      completed: ["UGC_IMAGES_CREATED", "OPENAI_IMAGE_REQUEST_END"],
      failed: ["UGC_IMAGES_FAILED", "OPENAI_IMAGE_REQUEST_FAILED", "OPENAI_IMAGE_TIMEOUT", "shopee_ugc_image_generation_failed"],
      staleStartedAfterMs: 195_000
    };
    const blobStatusInput = {
      started: ["BLOB_UPLOAD_STARTED"],
      completed: ["BLOB_UPLOAD_COMPLETED", "UGC_IMAGES_CREATED"],
      failed: ["BLOB_UPLOAD_FAILED"]
    };
    let storyboardStatus = getStageStatusSummary(runStageLogs, storyboardStatusInput);
    let captionStatus = getStageStatusSummary(runStageLogs, captionStatusInput);
    let imageStatus = getStageStatusSummary(runStageLogs, imageStatusInput);
    let blobStatus = getStageStatusSummary(runStageLogs, blobStatusInput);
    let storyboardStatusSource = getStageStatusSource(runStageLogs, storyboardStatusInput);
    let captionStatusSource = getStageStatusSource(runStageLogs, captionStatusInput);
    let imageStatusSource = getStageStatusSource(runStageLogs, imageStatusInput);
    let blobStatusSource = getStageStatusSource(runStageLogs, blobStatusInput);
    const latestCaptionLog = getLatestStageLog(runStageLogs, [
      "CAPTION_CREATED",
      "CAPTION_FALLBACK_USED",
      "CAPTION_PRIMARY_FAILED",
      "CAPTION_FAILED",
      "CAPTION_VALIDATION_FAILED_DETAIL",
      "CAPTION_STARTED"
    ]);
    const latestCaptionFallbackLog = getLatestStageLog(runStageLogs, ["CAPTION_FALLBACK_USED"]);
    const latestCaptionMetadata = (latestCaptionLog?.metadata ?? {}) as Record<string, unknown>;
    const latestCaptionFallbackMetadata = (latestCaptionFallbackLog?.metadata ?? {}) as Record<string, unknown>;
    const latestCaptionFailureLog = getLatestStageLog(runStageLogs, [
      "CAPTION_FAILED",
      "CAPTION_VALIDATION_FAILED_DETAIL",
      "CAPTION_READABILITY_FAILED",
      "CAPTION_PRIMARY_FAILED"
    ]);
    const latestCaptionFailureMetadata = (latestCaptionFailureLog?.metadata ?? {}) as Record<string, unknown>;
    if (
      captionStatus === "created" &&
      (
        getStageStep(latestCaptionLog as StageLog) === "CAPTION_FALLBACK_USED" ||
        latestCaptionMetadata.captionStatus === "fallback_created" ||
        latestCaptionFallbackLog
      )
    ) {
      captionStatus = "fallback_created";
      captionStatusSource = latestCaptionFallbackLog
        ? `action_log:${getStageStep(latestCaptionFallbackLog)}`
        : captionStatusSource;
    }
    const latestCaptionSerializedError = getSerializedErrorMetadata(latestCaptionFailureMetadata);
    const captionLastError =
      typeof latestCaptionMetadata.captionLastError === "string" && latestCaptionMetadata.captionLastError
        ? String(latestCaptionMetadata.captionLastError)
        : typeof latestCaptionFallbackMetadata.errorMessage === "string" && latestCaptionFallbackMetadata.errorMessage
        ? String(latestCaptionFallbackMetadata.errorMessage)
        : typeof latestCaptionFailureMetadata.errorMessage === "string" && latestCaptionFailureMetadata.errorMessage
          ? String(latestCaptionFailureMetadata.errorMessage)
          : typeof latestCaptionSerializedError?.message === "string"
            ? String(latestCaptionSerializedError.message)
            : null;
    const captionProvider =
      typeof latestCaptionMetadata.provider === "string"
        ? String(latestCaptionMetadata.provider)
        : typeof latestCaptionFallbackMetadata.provider === "string"
          ? String(latestCaptionFallbackMetadata.provider)
          : null;
    const captionRetryCount =
      typeof latestCaptionMetadata.captionRetryCount === "number"
        ? latestCaptionMetadata.captionRetryCount
        : typeof latestCaptionFallbackMetadata.captionRetryCount === "number"
          ? latestCaptionFallbackMetadata.captionRetryCount
          : typeof latestCaptionFailureMetadata.captionRetryCount === "number"
            ? latestCaptionFailureMetadata.captionRetryCount
            : null;
    const captionValidationRule =
      typeof latestCaptionMetadata.captionValidationRule === "string"
        ? String(latestCaptionMetadata.captionValidationRule)
        : typeof latestCaptionFallbackMetadata.captionValidationRule === "string"
          ? String(latestCaptionFallbackMetadata.captionValidationRule)
          : typeof latestCaptionFailureMetadata.captionValidationRule === "string"
            ? String(latestCaptionFailureMetadata.captionValidationRule)
            : typeof latestCaptionFailureMetadata.matchedRule === "string"
              ? String(latestCaptionFailureMetadata.matchedRule)
              : null;
    const captionValidationReason =
      typeof latestCaptionMetadata.captionValidationReason === "string"
        ? String(latestCaptionMetadata.captionValidationReason)
        : typeof latestCaptionFallbackMetadata.captionValidationReason === "string"
          ? String(latestCaptionFallbackMetadata.captionValidationReason)
          : typeof latestCaptionFailureMetadata.captionValidationReason === "string"
            ? String(latestCaptionFailureMetadata.captionValidationReason)
            : typeof latestCaptionFailureMetadata.reason === "string"
              ? String(latestCaptionFailureMetadata.reason)
              : null;
    const captionOffendingText =
      typeof latestCaptionMetadata.offendingText === "string"
        ? String(latestCaptionMetadata.offendingText)
        : typeof latestCaptionFallbackMetadata.offendingText === "string"
          ? String(latestCaptionFallbackMetadata.offendingText)
          : typeof latestCaptionFailureMetadata.offendingText === "string"
            ? String(latestCaptionFailureMetadata.offendingText)
            : null;
    const captionFallbackUsed =
      Boolean(latestCaptionFallbackLog) ||
      latestCaptionMetadata.captionStatus === "fallback_created" ||
      captionStatus === "fallback_created";
    const latestImageRequestLog = getLatestStageLog(runStageLogs, [
      "OPENAI_IMAGE_REQUEST_END",
      "OPENAI_IMAGE_REQUEST_FAILED",
      "OPENAI_IMAGE_TIMEOUT",
      "OPENAI_IMAGE_REQUEST_START"
    ]);
    const latestImageFailureLog = getLatestStageLog(runStageLogs, [
      "PACKAGE_IMAGE_COUNT_CHECK_FAILED",
      "IMAGE_DOC_COUNT_CHECK_FAILED",
      "MONGO_SAVE_FAILED",
      "BLOB_UPLOAD_FAILED",
      "IMAGE_COUNT_CHECK_FAILED",
      "IMAGE_BATCH_FAILED",
      "IMAGE_TASK_FAILED",
      "UGC_IMAGES_FAILED",
      "OPENAI_IMAGE_REQUEST_FAILED",
      "OPENAI_IMAGE_TIMEOUT"
    ]);
    if (
      blobStatus === "pending" &&
      latestImageRequestLog &&
      getStageStep(latestImageRequestLog) === "OPENAI_IMAGE_REQUEST_END" &&
      isStageLogOlderThan(latestImageRequestLog, 120_000)
    ) {
      blobStatus = "failed";
      blobStatusSource = "status_mapping:stale_after_OPENAI_IMAGE_REQUEST_END";
    }
    const latestImageRequestMetadata = (latestImageRequestLog?.metadata ?? {}) as Record<string, unknown>;
    const imageStartedLogIsStale =
      Boolean(latestImageRequestLog) &&
      getStageStep(latestImageRequestLog as StageLog) === "OPENAI_IMAGE_REQUEST_START" &&
      isStageLogOlderThan(latestImageRequestLog, 195_000);
    const imageFailureDetails = getStageFailureDetails(
      latestImageFailureLog,
      imageStatus === "failed" && imageStartedLogIsStale
        ? {
            source: "status_mapping",
            reason: "imageStatus was derived as failed because the latest OPENAI_IMAGE_REQUEST_START log is stale and no later image failure log was found"
          }
        : imageStatus === "failed"
          ? {
              source: "status_mapping",
              reason: "imageStatus was derived as failed by stage status mapping without a failure log containing an error"
            }
          : undefined
    );
    const imageDurationMs =
      typeof latestImageRequestMetadata.durationMs === "number"
        ? latestImageRequestMetadata.durationMs
        : latestImageRequestMetadata.durationMs
          ? Number(latestImageRequestMetadata.durationMs)
          : null;
    const imageRetryCount =
      typeof latestImageRequestMetadata.retryCount === "number"
        ? latestImageRequestMetadata.retryCount
        : latestImageRequestMetadata.retryCount
          ? Number(latestImageRequestMetadata.retryCount)
          : null;
    const imageLastError =
      typeof latestImageRequestMetadata.errorMessage === "string"
        ? latestImageRequestMetadata.errorMessage
        : typeof latestImageRequestMetadata.serializedError === "object" && latestImageRequestMetadata.serializedError
          ? String((latestImageRequestMetadata.serializedError as Record<string, unknown>).message ?? "")
          : imageStatus === "failed"
            ? imageFailureDetails.reason
            : null;
    const latestStoryboardRequestLog = getLatestStageLog(runStageLogs, [
      "STORYBOARD_CREATED",
      "OPENAI_STORYBOARD_REQUEST_END",
      "OPENAI_STORYBOARD_REQUEST_FAILED",
      "OPENAI_STORYBOARD_REQUEST_TIMEOUT",
      "STORYBOARD_TIMEOUT",
      "OPENAI_STORYBOARD_REQUEST_START",
      "STORYBOARD_STARTED",
      "STORYBOARD_RETRYING"
    ]);
    const latestStoryboardRequestMetadata = (latestStoryboardRequestLog?.metadata ?? {}) as Record<string, unknown>;
    const storyboardDurationMs =
      typeof latestStoryboardRequestMetadata.storyboardDurationMs === "number"
        ? latestStoryboardRequestMetadata.storyboardDurationMs
        : typeof latestStoryboardRequestMetadata.durationMs === "number"
          ? latestStoryboardRequestMetadata.durationMs
          : latestStoryboardRequestMetadata.durationMs
            ? Number(latestStoryboardRequestMetadata.durationMs)
            : null;
    const storyboardRetryCount =
      typeof latestStoryboardRequestMetadata.retryCount === "number"
        ? latestStoryboardRequestMetadata.retryCount
        : latestStoryboardRequestMetadata.retryCount
          ? Number(latestStoryboardRequestMetadata.retryCount)
          : null;
    const storyboardLastError =
      typeof latestStoryboardRequestMetadata.errorMessage === "string"
        ? latestStoryboardRequestMetadata.errorMessage
        : typeof latestStoryboardRequestMetadata.serializedError === "object" && latestStoryboardRequestMetadata.serializedError
          ? String((latestStoryboardRequestMetadata.serializedError as Record<string, unknown>).message ?? "")
          : null;
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
    const templatePostJob = runJobs.find((job) => job.postId) ?? null;
    const templatePostId =
      templatePostMetadata.templatePostId
        ? String(templatePostMetadata.templatePostId)
        : templatePostMetadata.aiGeneratedPostId
          ? String(templatePostMetadata.aiGeneratedPostId)
          : templatePostJob?.postId
            ? String(templatePostJob.postId)
            : null;
    const lastPostId = templatePostJob?.postId ? String(templatePostJob.postId) : null;
    const templatePostIdSource =
      templatePostMetadata.templatePostId || templatePostMetadata.aiGeneratedPostId
        ? `action_log:${getStageStep(templatePostLog as StageLog)}`
        : templatePostJob?.postId
          ? "job.postId"
          : "none";
    const createdTasksSource = workflowRunId
      ? `Job(payload.workflowRunId=${workflowRunId})`
      : lastRunAtDate instanceof Date && !Number.isNaN(lastRunAtDate.getTime())
        ? `Job(payload.autoPostConfigId=${String(effectiveConfigDoc?._id ?? "")}, no currentRunId)`
        : "Job(autoPostConfigId fallback)";
    const publishedSource = createdTasksSource;
    const hasCreatedRunPackage = Boolean(templatePostId && createdTasksCount > 0);
    if (hasCreatedRunPackage) {
      if (storyboardStatus === "pending") {
        storyboardStatus = "created";
        storyboardStatusSource = "template_post_inferred:created_tasks_guard";
      }
      if (captionStatus === "pending") {
        captionStatus = "created";
        captionStatusSource = "template_post_inferred:created_tasks_guard";
      }
      if (imageStatus === "pending") {
        imageStatus = "created";
        imageStatusSource = "template_post_inferred:created_tasks_guard";
      }
      if (blobStatus === "pending") {
        blobStatus = "created";
        blobStatusSource = "template_post_inferred:created_tasks_guard";
      }
    }
    const latestRunStep = String(((latestRunLog?.metadata ?? {}) as Record<string, unknown>).step ?? "");
    const currentStep = noTaskRunIsActive
      ? preTaskBlockingStep || latestRunStep || "PREPARING_SHOPEE_POST_PACKAGE"
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
    const latestAttemptLog = logs.find((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      return (
        metadata.step === "PRODUCT_ATTEMPT_STARTED" ||
        metadata.step === "PRODUCT_ATTEMPT_FAILED" ||
        metadata.step === "PRODUCT_ATTEMPT_SUCCESS" ||
        metadata.step === "PRODUCT_SKIPPED" ||
        metadata.step === "SKIPPED_PRODUCT_WITH_REASON" ||
        metadata.step === "RETRYING_WITH_NEXT_PRODUCT"
      );
    });
    const latestSkippedProductLog = logs.find((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      const step = String(metadata.step ?? "");
      return step === "PRODUCT_SKIPPED" || step === "SKIPPED_PRODUCT_WITH_REASON" || step.startsWith("PRODUCT_SKIPPED_");
    });
    const latestAttemptMetadata = (latestAttemptLog?.metadata ?? {}) as Record<string, unknown>;
    const latestSkippedMetadata = (latestSkippedProductLog?.metadata ?? {}) as Record<string, unknown>;
    const latestSkippedReason = latestSkippedProductLog
      ? sanitizeLegacyMessage(String(
          latestSkippedMetadata.lastSkippedReason ??
          latestSkippedMetadata.skipReason ??
          latestSkippedMetadata.reason ??
          latestSkippedProductLog.message ??
          "Product skipped"
        ))
      : null;
    const latestDetailedErrorMessage =
      latestSkippedReason && String(effectiveConfig?.autoPostStatus ?? "").match(/retrying|running/i)
        ? `Product skipped: ${latestSkippedReason}`
        : sanitizedLastError;
    const pageFailureMessage = latestFailedJob
      ? `${pageNameById.get(String(latestFailedJob.targetPageId ?? "")) ?? "Facebook Page"}: ${
          sanitizeLegacyMessage(latestFailedJob.failureReason ?? latestFailedJob.lastError ?? latestFailedJob.errorCode ?? "Publish failed")
        }`
      : null;
    const mappedLastError = pageFailureMessage
      ? { source: "facebook_api", status: null, message: pageFailureMessage }
      : mapShopeeLastError(latestDetailedErrorMessage);
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
              return step === "PRODUCT_SKIPPED" || step === "SKIPPED_PRODUCT_WITH_REASON" || step.startsWith("PRODUCT_SKIPPED_");
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
      lastPublishAt:
        runJobs.find((job) => job.status === "success")?.completedAt ??
        runJobs.find((job) => job.status === "success")?.updatedAt ??
        null,
      provider: shopeeProvider.name,
      connectedPageCount,
      facebookPages: facebookPages.map((page: any) => ({
        pageId: String(page.pageId ?? page.id ?? page.externalPageId ?? ""),
        name: String(page.name ?? page.pageName ?? "Facebook Page")
      })).filter((page: { pageId: string; name: string }) => page.pageId.length > 0),
      currentJobId: latestProcessingJob ? String(latestProcessingJob._id) : runJobs[0]?._id ? String(runJobs[0]._id) : null,
      currentStep: isFindingValidProduct ? "FINDING_VALID_PRODUCT" : noTaskRunIsStale ? preTaskBlockingStep : currentStep,
      currentAttempt,
      maxProductAttempts,
      skippedProductsCount,
      currentProduct:
        latestAttemptMetadata.productName
          ? String(latestAttemptMetadata.productName)
          : productStageMetadata.productName
            ? String(productStageMetadata.productName)
            : null,
      currentProductId:
        latestAttemptMetadata.productId
          ? String(latestAttemptMetadata.productId)
          : productStageMetadata.productId
            ? String(productStageMetadata.productId)
            : null,
      templatePostId,
      storyboardStatus,
      storyboardStartedAt:
        typeof latestStoryboardRequestMetadata.startedAt === "string"
          ? latestStoryboardRequestMetadata.startedAt
          : typeof latestStoryboardRequestMetadata.storyboardStartedAt === "string"
            ? latestStoryboardRequestMetadata.storyboardStartedAt
            : latestStoryboardRequestLog?.createdAt ?? null,
      storyboardDurationMs: storyboardDurationMs !== null && Number.isFinite(storyboardDurationMs) ? storyboardDurationMs : null,
      storyboardProvider:
        typeof latestStoryboardRequestMetadata.provider === "string"
          ? latestStoryboardRequestMetadata.provider
          : null,
      storyboardRetryCount: storyboardRetryCount !== null && Number.isFinite(storyboardRetryCount) ? storyboardRetryCount : null,
      storyboardLastError: storyboardLastError ? sanitizeLegacyMessage(storyboardLastError) : null,
      captionStatus,
      captionLastError: captionLastError ? sanitizeLegacyMessage(captionLastError) : null,
      captionProvider: captionProvider ? sanitizeLegacyMessage(captionProvider) : null,
      captionRetryCount: captionRetryCount !== null && Number.isFinite(captionRetryCount) ? captionRetryCount : null,
      captionValidationRule: captionValidationRule ? sanitizeLegacyMessage(captionValidationRule) : null,
      captionValidationReason: captionValidationReason ? sanitizeLegacyMessage(captionValidationReason) : null,
      offendingText: captionOffendingText ? sanitizeLegacyMessage(captionOffendingText) : null,
      fallbackUsed: captionFallbackUsed,
      imageStatus,
      blobStatus,
      imageStartedAt:
        typeof latestImageRequestMetadata.startedAt === "string"
          ? latestImageRequestMetadata.startedAt
          : latestImageRequestLog?.createdAt ?? null,
      imageDurationMs: imageDurationMs !== null && Number.isFinite(imageDurationMs) ? imageDurationMs : null,
      imageProvider:
        typeof latestImageRequestMetadata.provider === "string"
          ? latestImageRequestMetadata.provider
          : null,
      imageRetryCount: imageRetryCount !== null && Number.isFinite(imageRetryCount) ? imageRetryCount : null,
      imageLastError: imageLastError ? sanitizeLegacyMessage(imageLastError) : null,
      imageFailureStep: imageFailureDetails.step,
      imageFailureSource: imageFailureDetails.source,
      imageFailureReason: imageFailureDetails.reason ? sanitizeLegacyMessage(imageFailureDetails.reason) : null,
      imageFailureStack: imageFailureDetails.stack ? String(imageFailureDetails.stack).slice(0, 3000) : null,
      lastSkippedReason: latestSkippedReason,
      productAttempt: currentAttempt,
      skippedProducts: latestSkippedMetadata.skippedProducts ?? null,
      templatePostCreationError: latestAttemptMetadata.templatePostCreationError ?? latestSkippedMetadata.templatePostCreationError ?? null,
      productUnderstandingError: latestAttemptMetadata.productUnderstandingError ?? latestSkippedMetadata.productUnderstandingError ?? null,
      captionGenerationError: latestAttemptMetadata.captionGenerationError ?? latestSkippedMetadata.captionGenerationError ?? null,
      affiliateLinkError: latestAttemptMetadata.affiliateLinkError ?? latestSkippedMetadata.affiliateLinkError ?? null,
      databaseSaveError: latestAttemptMetadata.databaseSaveError ?? latestSkippedMetadata.databaseSaveError ?? null,
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
      statusSourceTrace: {
        currentRunId: workflowRunId,
        templatePostId,
        lastPostId,
        templatePostIdSource,
        storyboardStatusSource,
        captionStatusSource,
        imageStatusSource,
        blobStatusSource,
        createdTasksSource,
        publishedSource
      },
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

    console.info("[STATUS_SOURCE_TRACE]", controlPanel.statusSourceTrace);

    console.info("[auto-post/control-panel] status fetch completed", {
      userId,
      state: controlPanel.state,
      connectedPageCount,
      provider: shopeeProvider.name,
      shopeeApiStatus,
      missingEnv
    });

    return jsonOk({ config: sanitizedConfig, logs: normalizedLogs.slice(0, 20), controlPanel });
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
