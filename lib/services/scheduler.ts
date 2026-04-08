import { enqueueJobsForDueSchedules, processQueuedJobs } from "@/lib/services/queue";

export async function processDueSchedules() {
  const queued = await enqueueJobsForDueSchedules();
  const processed = await processQueuedJobs();

  return {
    queued,
    processed
  };
}
