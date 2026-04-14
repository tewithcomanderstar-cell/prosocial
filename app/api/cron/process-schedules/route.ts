import { connectDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api";
import { processDueAutoPosts } from "@/lib/services/auto-post";
import { processQueuedJobs } from "@/lib/services/queue";
import { queueDueSchedules } from "@/lib/services/scheduler";
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
    const inlinePublisherEnabled = process.env.ENABLE_INLINE_PUBLISHER !== "false";
    const inlineBatchSize = Number(process.env.INLINE_PUBLISHER_BATCH_SIZE ?? "25");
    await connectDb();
    console.info("[SCHEDULER] started", { correlationId, inlinePublisherEnabled, inlineBatchSize });
    const [scheduledQueued, autoPostsQueued] = await Promise.all([
      queueDueSchedules(),
      processDueAutoPosts()
    ]);
    const processedJobs = inlinePublisherEnabled ? await processQueuedJobs(inlineBatchSize) : [];
    console.info("[SCHEDULER] completed", {
      correlationId,
      scheduledQueued,
      autoPostsQueued,
      processedJobs: processedJobs.length,
      durationMs: Date.now() - startedAt
    });

    return jsonOk(
      {
        scheduledQueued,
        autoPostsQueued,
        processedJobs,
        inlinePublisherEnabled,
        correlationId
      },
      "Automation tick processed"
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process schedules", 500);
  }
}
