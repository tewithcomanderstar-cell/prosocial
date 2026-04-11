import { connectDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api";
import { processDueAutoPosts } from "@/lib/services/auto-post";
import { processQueuedJobs } from "@/lib/services/queue";
import { queueDueSchedules } from "@/lib/services/scheduler";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return jsonError("Unauthorized", 401);
  }

  try {
    await connectDb();
    const [scheduledQueued, autoPostsQueued] = await Promise.all([
      queueDueSchedules(),
      processDueAutoPosts()
    ]);
    const processedJobs = await processQueuedJobs(50);

    return jsonOk(
      {
        scheduledQueued,
        autoPostsQueued,
        processedJobs
      },
      "Automation tick processed"
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process schedules", 500);
  }
}
