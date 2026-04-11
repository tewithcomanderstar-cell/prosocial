import { maintenanceQueue } from '@/src/jobs/queues';
import { acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

export async function enqueueRetryablePublishJobs(params: {
  dueBefore?: Date;
  correlationId: string;
}) {
  const lockKey = 'scheduler:retryable-publish-jobs';
  const lock = await acquireIdempotencyLock(lockKey, 90);
  if (!lock) return { skipped: true, reason: 'lock_not_acquired' as const };

  try {
    const dueBefore = params.dueBefore ?? new Date();
    await maintenanceQueue.add(
      'requeueRetryablePublishJobs',
      {
        dueBefore: dueBefore.toISOString(),
        correlationId: params.correlationId,
      },
      {
        jobId: `requeue:${dueBefore.toISOString()}`,
      }
    );

    logger.info('scheduler enqueued retryable publish job sweep', { correlationId: params.correlationId, dueBefore: dueBefore.toISOString() });
    return { queued: true };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}
