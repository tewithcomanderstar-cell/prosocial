import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { ActionLog } from "@/models/ActionLog";
import { FacebookConnection } from "@/models/FacebookConnection";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { getShopeeProductProvider } from "@/lib/services/shopee-affiliate";
import { safeLogAction } from "@/lib/services/logging";

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

    const configResult = await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          nextRunAt: new Date(),
          autoPostStatus: "paused",
          jobStatus: "pending",
          retryCount: 0
        }
      },
      { upsert: true, new: true }
    ).lean();

    const config = (configResult as AutoPostConfigStatusDoc | null) ?? null;

    const logs = await ActionLog.find({
      userId,
      "metadata.autoPost": true
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const legacyLastError = config?.lastError ?? null;
    const sanitizedLastError = sanitizeLegacyMessage(legacyLastError);
    const facebookConnection = await FacebookConnection.findOne({ userId }).lean();
    const connectedPageCount = Array.isArray((facebookConnection as any)?.pages) ? (facebookConnection as any).pages.length : 0;
    const shopeeProvider = getShopeeProductProvider();
    const lastProduct = await ShopeeProduct.findOne({}).sort({ fetchedAt: -1 }).select("fetchedAt").lean();
    const lastPublishedQueueItem = await FacebookPostQueue.findOne({ userId, status: "published" })
      .sort({ updatedAt: -1 })
      .select("updatedAt")
      .lean();
    const hasAffiliateTracking = typeof config?.shopeeTrackingId === "string" && config.shopeeTrackingId.trim().length > 0;
    const contentSource = String(config?.contentSource ?? "shopee-affiliate");
    const shopeeSetupReady = contentSource === "shopee-affiliate" && Boolean(config?.shopeeSourceTag);
    const facebookReady = connectedPageCount > 0;

    const controlPanel = {
      state: !shopeeSetupReady ? "setup_required" : !facebookReady ? "facebook_required" : "ready",
      shopeeApiStatus: shopeeProvider.name === "mock-shopee-provider" ? "mock_provider_ready" : "configured",
      affiliateConfigStatus: hasAffiliateTracking ? "configured" : "setup_required",
      facebookPageStatus: facebookReady ? "connected" : "missing",
      autoPostEngineStatus: config?.autoPostStatus ?? "paused",
      lastProductFetchAt: (lastProduct as any)?.fetchedAt ?? null,
      lastPublishAt: (lastPublishedQueueItem as any)?.updatedAt ?? null,
      provider: shopeeProvider.name,
      connectedPageCount
    };

    if (config && isLegacyMessage(legacyLastError)) {
      await AutoPostConfig.findByIdAndUpdate(config._id, {
        lastError: null,
        lastStatus: config.autoPostStatus === "paused" ? "paused" : config.lastStatus ?? "pending"
      });
    }

    const sanitizedConfig = config
      ? {
          ...config,
          lastError: sanitizedLastError
        }
      : config;

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

    await safeLogAction({
      userId,
      type: "queue",
      level: "info",
      message: "Auto Post control panel status loaded",
      metadata: {
        autoPost: true,
        shopeeAffiliate: true,
        controlPanelState: controlPanel.state,
        shopeeApiStatus: controlPanel.shopeeApiStatus,
        affiliateConfigStatus: controlPanel.affiliateConfigStatus,
        facebookPageStatus: controlPanel.facebookPageStatus,
        connectedPageCount
      }
    });

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
