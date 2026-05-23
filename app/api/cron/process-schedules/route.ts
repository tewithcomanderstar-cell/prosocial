import { connectDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api";
import { processDueAutoPosts } from "@/lib/services/auto-post";
import { processDueAutoPostAiConfigs } from "@/lib/services/auto-post-ai";
import { syncTrackedAutoCommentPosts } from "@/lib/services/comment-automation";
import { processQueuedJobs } from "@/lib/services/queue";
import { queueDueSchedules } from "@/lib/services/scheduler";
import { runStorageCleanup } from "@/lib/services/storage-cleanup";
import { runPlatformScheduler } from "@/src/jobs/schedulers/run-platform-scheduler";
import { randomUUID } from "crypto";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const correlationId = randomUUID();
    const startedAt = Date.now();
    const schedulerEngine = process.env.SCHEDULER_ENGINE === "prisma" ? "prisma" : "legacy";
    const inlinePublisherEnabled = process.env.ENABLE_INLINE_PUBLISHER !== "false";
    const inlineBatchSize = Number(process.env.INLINE_PUBLISHER_BATCH_SIZE ?? "3");
    console.info("[SCHEDULER] started", { correlationId, schedulerEngine, inlinePublisherEnabled, inlineBatchSize });

    if (schedulerEngine === "prisma") {
      const summary = await runPlatformScheduler({ correlationId });
      return jsonOk(
        {
          ...summary,
          durationMs: Date.now() - startedAt
        },
        "Prisma scheduler tick processed"
      );
    }

    await connectDb();
    const cleanup = await runStorageCleanup({ reason: "pre_scheduler_tick" });
    const scheduledQueued = await queueDueSchedules();
    const autoPostsQueued = await processDueAutoPosts();
    const autoPostAiQueued = await processDueAutoPostAiConfigs();
    const syncedComments = await syncTrackedAutoCommentPosts();
    const processedJobs = inlinePublisherEnabled ? await processQueuedJobs(inlineBatchSize) : [];
    console.info("[SCHEDULER] completed", {
      correlationId,
      scheduledQueued,
      autoPostsQueued,
      autoPostAiQueued,
      syncedComments,
      processedJobs: processedJobs.length,
      storageCleanupDeleted: cleanup.deletedTotal,
      durationMs: Date.now() - startedAt
    });

    return jsonOk(
      {
        scheduledQueued,
        autoPostsQueued,
        autoPostAiQueued,
        syncedComments,
        processedJobs,
        storageCleanup: {
          deletedTotal: cleanup.deletedTotal,
          mode: cleanup.mode,
          beforePercent: cleanup.before.percent,
          afterPercent: cleanup.after.percent
        },
        schedulerEngine,
        inlinePublisherEnabled,
        correlationId
      },
      "Automation tick processed"
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process schedules", 500);
  }
}
