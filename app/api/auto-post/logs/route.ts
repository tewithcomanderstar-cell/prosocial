import { jsonError, jsonOk, requireAuth } from "@/lib/api";
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

export async function GET() {
  try {
    const userId = await requireAuth();
    const jobs = await Job.find({
      userId,
      "payload.autoSource": "google-drive"
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const normalizedJobs = jobs.map((job) => ({
      _id: String(job._id),
      targetPageId: job.targetPageId ? String(job.targetPageId) : null,
      status: normalizeJobStatus(job.status as RawJobStatus),
      rawStatus: job.status,
      createdAt: job.createdAt,
      processingStartedAt: job.processingStartedAt,
      completedAt: job.completedAt,
      lastError: job.lastError ?? null,
      retryCount: job.attempts ?? 0,
      maxAttempts: job.maxAttempts ?? 3
    }));

    return jsonOk({ jobs: normalizedJobs });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
