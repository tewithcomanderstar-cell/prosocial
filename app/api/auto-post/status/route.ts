import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { ActionLog } from "@/models/ActionLog";
import { FacebookConnection } from "@/models/FacebookConnection";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { getShopeeProductProvider } from "@/lib/services/shopee-affiliate";

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
    const lastProduct = await ShopeeProduct.findOne({}).sort({ fetchedAt: -1 }).select("fetchedAt").lean();
    const lastPublishedQueueItem = await FacebookPostQueue.findOne({ userId, status: "published" })
      .sort({ updatedAt: -1 })
      .select("updatedAt")
      .lean();
    const hasAffiliateTracking =
      typeof effectiveConfig?.shopeeTrackingId === "string" && effectiveConfig.shopeeTrackingId.trim().length > 0;
    const contentSource = String(effectiveConfig?.contentSource ?? "shopee-affiliate");
    const shopeeSetupReady = contentSource === "shopee-affiliate" && Boolean(effectiveConfig?.shopeeSourceTag);
    const facebookReady = connectedPageCount > 0;

    const controlPanel = {
      state: !shopeeSetupReady ? "setup_required" : !facebookReady ? "facebook_required" : "ready",
      shopeeApiStatus: shopeeProvider.name === "mock-shopee-provider" ? "mock_provider_ready" : "configured",
      affiliateConfigStatus: hasAffiliateTracking ? "configured" : "setup_required",
      facebookPageStatus: facebookReady ? "connected" : "missing",
      autoPostEngineStatus: effectiveConfig?.autoPostStatus ?? "paused",
      lastProductFetchAt: (lastProduct as any)?.fetchedAt ?? null,
      lastPublishAt: (lastPublishedQueueItem as any)?.updatedAt ?? null,
      provider: shopeeProvider.name,
      connectedPageCount
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
      provider: shopeeProvider.name
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
