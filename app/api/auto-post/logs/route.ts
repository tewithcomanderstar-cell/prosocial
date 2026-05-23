import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { ActionLog } from "@/models/ActionLog";
import { Job } from "@/models/Job";

type RawJobStatus = "queued" | "processing" | "success" | "failed" | "retrying" | "rate_limited" | "duplicate_blocked";
type UiJobStatus = "pending" | "processing" | "posted" | "failed" | "retrying";

function normalizeJobStatus(status: RawJobStatus): UiJobStatus {
  if (status === "queued") return "pending";
  if (status === "processing") return "processing";
  if (status === "success") return "posted";
  if (status === "retrying" || status === "rate_limited") return "retrying";
  return "failed";
}

function sanitizeLegacyMessage(value?: string | null) {
  if (!value) return value ?? null;

  const normalized = value.toLowerCase();
  if (
    normalized.includes("n8n") ||
    normalized.includes("requested webhook") ||
    normalized.includes("workflow must be active") ||
    normalized.includes("webhook")
  ) {
    return "Legacy automation status detected.";
  }

  return value;
}

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");
    const workflowRunId = searchParams.get("workflowRunId");
    const jobQuery: Record<string, unknown> = {
      userId,
      type: "post",
      $or: [
        { "payload.autoSource": "shopee-affiliate" },
        { "payload.autoPostConfigId": { $exists: true } }
      ]
    };

    if (jobId) {
      jobQuery._id = jobId;
    }

    if (workflowRunId) {
      jobQuery["payload.workflowRunId"] = workflowRunId;
    }

    const jobs = await Job.find(jobQuery)
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const normalizedJobs = jobs.map((job) => ({
      _id: String(job._id),
      targetPageId: job.targetPageId ? String(job.targetPageId) : null,
      status: normalizeJobStatus(job.status as RawJobStatus),
      rawStatus: job.status,
      createdAt: job.createdAt,
      lastAttemptAt: job.lastAttemptAt ?? null,
      nextRetryAt: job.nextRetryAt ?? null,
      processingStartedAt: job.processingStartedAt,
      completedAt: job.completedAt,
      lastError: sanitizeLegacyMessage(job.lastError ?? null),
      failureReason: sanitizeLegacyMessage(job.failureReason ?? null),
      errorCode: job.errorCode ?? null,
      correlationId: job.correlationId ?? null,
      retryCount: job.attempts ?? 0,
      maxAttempts: job.maxAttempts ?? 3
    }));

    const actionQuery: Record<string, unknown> = {
      userId,
      "metadata.autoPost": true
    };
    if (jobId) {
      actionQuery.relatedJobId = jobId;
    }
    if (workflowRunId) {
      actionQuery["metadata.workflowRunId"] = workflowRunId;
    }

    const logs = await ActionLog.find(actionQuery)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return jsonOk({
      jobs: normalizedJobs,
      logs: logs.map((log) => ({
        _id: String(log._id),
        level: log.level,
        message: sanitizeLegacyMessage(log.message),
        createdAt: log.createdAt,
        metadata: log.metadata ?? {}
      }))
    });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
