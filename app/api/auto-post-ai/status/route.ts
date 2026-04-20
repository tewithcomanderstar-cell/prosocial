import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
import { ActionLog } from "@/models/ActionLog";

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

    const configResult = await AutoPostAiConfig.findOneAndUpdate(
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
      "metadata.autoPostAi": true
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const legacyLastError = config?.lastError ?? null;
    const sanitizedLastError = sanitizeLegacyMessage(legacyLastError);

    if (config && isLegacyMessage(legacyLastError)) {
      await AutoPostAiConfig.findByIdAndUpdate(config._id, {
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

    return jsonOk({ config: sanitizedConfig, logs: normalizedLogs });
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return jsonError("Unauthorized", 401);
    }

    return jsonError(error instanceof Error ? error.message : "Unable to load auto-post status", 500);
  }
}


