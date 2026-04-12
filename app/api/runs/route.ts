import { z } from "zod";
import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { mapLegacyJobToWorkflowRun } from "@/lib/domain/mappers";
import { Job } from "@/models/Job";
import { handleRoleError, requireRole } from "@/lib/services/permissions";

const retrySchema = z.object({
  runId: z.string().min(1)
});

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const triggerSource = searchParams.get("triggerSource");

    const jobs = (await Job.find({ userId }).sort({ createdAt: -1 }).limit(100).lean()) as Array<Record<string, unknown>>;
    const runs = jobs.map((job) => mapLegacyJobToWorkflowRun(job)).filter((run) => {
      if (status && run.status !== status) return false;
      if (triggerSource && run.triggerSource !== triggerSource) return false;
      return true;
    });

    const summary = {
      totalRuns: runs.length,
      pendingRuns: runs.filter((run) => run.status === "pending").length,
      runningRuns: runs.filter((run) => run.status === "running").length,
      failedRuns: runs.filter((run) => run.status === "failed").length,
      successRate: runs.length
        ? Math.round((runs.filter((run) => run.status === "succeeded").length / runs.length) * 100)
        : 0
    };

    return jsonOk({ runs, summary });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    await requireRole(["admin", "editor"]);
    const payload = retrySchema.parse(await request.json());

    const job = await Job.findByIdAndUpdate(
      payload.runId,
      {
        $set: {
          status: "queued",
          nextRunAt: new Date(),
          lastError: null,
          processingStartedAt: null,
          completedAt: null
        }
      },
      { new: true }
    ).lean();

    if (!job) {
      return jsonError("Run not found", 404);
    }

    return jsonOk({ run: mapLegacyJobToWorkflowRun(job as Record<string, unknown>) }, "Run queued for retry");
  } catch (error) {
    return handleRoleError(error);
  }
}
