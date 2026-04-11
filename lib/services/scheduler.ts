import { enqueueJobsForDueSchedules } from "@/lib/services/queue";

export async function queueDueSchedules() {
  return enqueueJobsForDueSchedules();
}

export async function processDueSchedules() {
  const queued = await enqueueJobsForDueSchedules();
  return {
    queued
  };
}
