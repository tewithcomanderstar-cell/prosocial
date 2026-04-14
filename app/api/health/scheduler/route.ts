import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { Job } from "@/models/Job";
import { Schedule } from "@/models/Schedule";
import { prisma } from "@/src/lib/db/prisma";

export async function GET() {
  try {
    await requireAuth();

    const schedulerEngine = process.env.SCHEDULER_ENGINE === "prisma" ? "prisma" : "legacy";

    if (schedulerEngine === "prisma") {
      const now = new Date();
      const [duePublishJobs, retryableJobs, stuckRuns] = await Promise.all([
        prisma.publishJob.count({
          where: {
            status: { in: ["queued", "retry_scheduled"] },
            nextAttemptAt: { lte: now }
          }
        }),
        prisma.publishJob.count({
          where: {
            status: "retry_scheduled"
          }
        }),
        prisma.workflowRun.count({
          where: {
            status: "running",
            startedAt: { lte: new Date(Date.now() - 30 * 60 * 1000) }
          }
        })
      ]);

      return NextResponse.json({
        ok: true,
        data: {
          schedulerEngine,
          duePublishJobs,
          retryableJobs,
          stuckRuns
        }
      });
    }

    await connectDb();
    const now = new Date();
    const [dueSchedules, dueJobs, stuckJobs] = await Promise.all([
      Schedule.countDocuments({ enabled: true, nextRunAt: { $lte: now } }),
      Job.countDocuments({ status: { $in: ["queued", "retrying", "rate_limited"] }, nextRunAt: { $lte: now } }),
      Job.countDocuments({
        status: "processing",
        processingStartedAt: { $lte: new Date(Date.now() - 10 * 60 * 1000) }
      })
    ]);

    return NextResponse.json({
      ok: true,
      data: {
        schedulerEngine,
        dueSchedules,
        dueJobs,
        stuckJobs
      }
    });
  } catch {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
}
