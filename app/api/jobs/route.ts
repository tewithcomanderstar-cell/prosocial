import { isUnauthorizedError, jsonError, jsonOk, requireAuth } from "@/lib/api";
import { Job } from "@/models/Job";

export async function GET() {
  try {
    const userId = await requireAuth();
    const jobs = await Job.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return jsonOk({
      jobs: jobs.map((job) => ({
        ...job,
        nextRetryAt: job.nextRetryAt ?? null,
        lastAttemptAt: job.lastAttemptAt ?? null,
        failureReason: job.failureReason ?? null,
        errorCode: job.errorCode ?? null,
        errorDetails: job.errorDetails ?? null,
        lockedAt: job.lockedAt ?? null,
        lockExpiresAt: job.lockExpiresAt ?? null,
        correlationId: job.correlationId ?? null
      }))
    });
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return jsonError("Unauthorized", 401);
    }

    return jsonError(error instanceof Error ? error.message : "Unable to load jobs", 500);
  }
}
