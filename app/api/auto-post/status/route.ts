import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { ActionLog } from "@/models/ActionLog";
import { FacebookConnection } from "@/models/FacebookConnection";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { getShopeeAffiliateConfigStatus, getShopeeEnvStatus, getShopeeProductProvider } from "@/lib/services/shopee-affiliate";

type AutoPostConfigStatusDoc = {
  _id: unknown;
  autoPostStatus?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  [key: string]: unknown;
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
    const connectedPageCount = Array.isArray((facebookConnection as any)?.pages) ? (facebookConnection as any).pages.length : 0;
    const shopeeProvider = getShopeeProductProvider();
    const shopeeEnvStatus = getShopeeEnvStatus();
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
    const mappedLastError = mapShopeeLastError(sanitizedLastError);
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
      missingEnv,
      env: {
        ok: shopeeEnvStatus.ok,
        missing: shopeeEnvStatus.missing,
        configured: shopeeEnvStatus.configured
      },
      lastError
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
