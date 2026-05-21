import { jsonError, jsonOk } from "@/lib/api";
import { updateAutoPostRecords } from "@/lib/services/automation-records";
import { logAction } from "@/lib/services/logging";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { Job } from "@/models/Job";

const AUTO_POST_JOB_TIMEOUT_MS = Number(process.env.AUTO_POST_JOB_TIMEOUT_MS ?? "300000");

type LeanAutoPostConfig = {
  _id: unknown;
  autoPostStatus?: string | null;
  lastRunAt?: Date | string | null;
};

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - AUTO_POST_JOB_TIMEOUT_MS);
    const config = (await AutoPostConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;

    if (!config) {
      return jsonError("Auto Post settings not found", 404);
    }

    const stuckJobs = await Job.updateMany(
      {
        userId,
        type: "post",
        status: "processing",
        $or: [{ lockExpiresAt: { $lte: now } }, { processingStartedAt: { $lte: staleBefore } }]
      },
      {
        status: "failed",
        completedAt: now,
        lastError: "Cleared stuck posting job from control panel",
        failureReason: "Job was stuck in processing beyond the configured timeout.",
        errorCode: "stuck_job_cleared",
        errorDetails: { clearedAt: now.toISOString(), timeoutMs: AUTO_POST_JOB_TIMEOUT_MS }
      }
    );

    await AutoPostConfig.findByIdAndUpdate(config._id, {
      autoPostStatus: "failed",
      jobStatus: "failed",
      lastStatus: "failed",
      retryCount: 0,
      lastError: "Cleared stuck posting status. Please retry Start Now."
    });

    await updateAutoPostRecords({
      configId: String(config._id),
      autoPostStatus: "failed",
      currentJobStatus: "failed",
      message: "Cleared stuck posting status"
    });

    await logAction({
      userId,
      type: "queue",
      level: "warn",
      message: "Cleared stuck Auto Post status from control panel",
      metadata: {
        autoPost: true,
        autoPostConfigId: String(config._id),
        action: "clear-stuck",
        previousStatus: config.autoPostStatus ?? null,
        stuckJobsMatched: stuckJobs.matchedCount,
        stuckJobsModified: stuckJobs.modifiedCount,
        timeoutMs: AUTO_POST_JOB_TIMEOUT_MS
      }
    });

    return jsonOk(
      {
        cleared: true,
        stuckJobsMatched: stuckJobs.matchedCount,
        stuckJobsModified: stuckJobs.modifiedCount
      },
      "Cleared stuck Auto Post status"
    );
  } catch (error) {
    return handleRoleError(error);
  }
}
