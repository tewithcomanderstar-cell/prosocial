import { connectDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api";
import { processDueAutoPosts } from "@/lib/services/auto-post";
import { processDueAutoPostAiConfigs } from "@/lib/services/auto-post-ai";
import { syncTrackedAutoCommentPosts } from "@/lib/services/comment-automation";
import { processQueuedJobs } from "@/lib/services/queue";
import { queueDueSchedules } from "@/lib/services/scheduler";
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
    const inlineBatchSize = Number(process.env.INLINE_PUBLISHER_BATCH_SIZE ?? "25");
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
    const [scheduledQueued, autoPostsQueued, autoPostAiQueued, syncedComments] = await Promise.all([
      queueDueSchedules(),
      processDueAutoPosts(),
      processDueAutoPostAiConfigs(),
      syncTrackedAutoCommentPosts()
    ]);
    const processedJobs = inlinePublisherEnabled ? await processQueuedJobs(inlineBatchSize) : [];
    console.info("[SCHEDULER] completed", {
      correlationId,
      scheduledQueued,
      autoPostsQueued,
      autoPostAiQueued,
      syncedComments,
      processedJobs: processedJobs.length,
      durationMs: Date.now() - startedAt
    });

    return jsonOk(
      {
        scheduledQueued,
        autoPostsQueued,
        autoPostAiQueued,
        syncedComments,
        processedJobs,
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
