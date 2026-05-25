import { isUnauthorizedError, jsonError, jsonOk } from "@/lib/api";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
import { ActionLog } from "@/models/ActionLog";
import { Job } from "@/models/Job";

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

async function getRuntimeStatusOverride(config: AutoPostConfigStatusDoc, userId: string) {
  const activeStatus = ["running", "posting", "retrying"].includes(String(config.autoPostStatus ?? ""));
  if (!activeStatus || !config._id) {
    return null;
  }

  const query: Record<string, unknown> = {
    userId,
    type: "post",
    "payload.autoPostAiConfigId": String(config._id)
  };

  if (config.lastWorkflowRunId) {
    query["payload.workflowRunId"] = String(config.lastWorkflowRunId);
  }

  const jobs = (await Job.find(query)
    .sort({ createdAt: 1 })
    .select("status failureReason lastError errorCode nextRunAt")
    .lean()) as Array<{
    status?: string;
    failureReason?: string;
    lastError?: string;
    errorCode?: string;
    nextRunAt?: Date | string | null;
  }>;

  if (!jobs.length) {
    return null;
  }

  const successCount = jobs.filter((job) => job.status === "success").length;
  const failedJobs = jobs.filter((job) => job.status === "failed" || job.status === "duplicate_blocked");
  const activeCount = jobs.filter((job) => job.status === "processing").length;
  const retryingCount = jobs.filter((job) => job.status === "retrying" || job.status === "rate_limited").length;
  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const latestFailure = failedJobs[failedJobs.length - 1] ?? null;
  const latestFailureMessage =
    latestFailure?.failureReason ||
    latestFailure?.lastError ||
    (latestFailure?.errorCode ? `Publish failed with ${latestFailure.errorCode}` : null);

  if (activeCount > 0) {
    return {
      autoPostStatus: "posting",
      jobStatus: "processing",
      lastStatus: "pending",
      lastError: null
    };
  }

  if (retryingCount > 0) {
    return {
      autoPostStatus: "retrying",
      jobStatus: "pending",
      lastStatus: "pending",
      lastError: latestFailureMessage
    };
  }

  if (queuedCount > 0) {
    return {
      autoPostStatus: "waiting",
      jobStatus: "pending",
      lastStatus: "pending",
      lastError: null
    };
  }

  if (successCount > 0) {
    return {
      autoPostStatus: "success",
      jobStatus: "posted",
      lastStatus: "posted",
      lastError:
        failedJobs.length > 0
          ? latestFailureMessage ?? `Published ${successCount}/${jobs.length} page(s); ${failedJobs.length} failed.`
          : null
    };
  }

  if (failedJobs.length > 0) {
    return {
      autoPostStatus: "failed",
      jobStatus: "failed",
      lastStatus: "failed",
      lastError: latestFailureMessage ?? "Publishing failed for all selected pages."
    };
  }

  return null;
}

export async function GET() {
  try {
    const { requireAuth } = await import("@/lib/api");
    const userId = await requireAuth();

    // This endpoint is polled by the dashboard. Keep it read-only so a slow or
    // quota-blocked MongoDB write cannot make the status card hang.
    const configResult = await AutoPostAiConfig.findOne({ userId }).lean();

    const config =
      (configResult as AutoPostConfigStatusDoc | null) ??
      ({
        _id: null,
        userId,
        nextRunAt: new Date(),
        autoPostStatus: "paused",
        jobStatus: "pending",
        retryCount: 0,
        lastError: null
      } as AutoPostConfigStatusDoc);

    const logs = await ActionLog.find({
      userId,
      "metadata.autoPostAi": true
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const legacyLastError = config?.lastError ?? null;
    const sanitizedLastError = sanitizeLegacyMessage(legacyLastError);

    const runtimeStatusOverride = await getRuntimeStatusOverride(config, userId);

    const sanitizedConfig = config
      ? {
          ...config,
          ...(runtimeStatusOverride ?? {}),
          lastError: runtimeStatusOverride?.lastError ?? (isLegacyMessage(legacyLastError) ? null : sanitizedLastError)
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


