import { processDueAutoPosts } from "@/lib/services/auto-post";
import { enqueueJobsForDueSchedules, processQueuedJobs } from "@/lib/services/queue";

export async function processDueSchedules() {
  const queued = await enqueueJobsForDueSchedules();
  const autoQueued = await processDueAutoPosts();
  const processed = await processQueuedJobs();

  return {
    queued,
    autoQueued,
    processed
  };
}
