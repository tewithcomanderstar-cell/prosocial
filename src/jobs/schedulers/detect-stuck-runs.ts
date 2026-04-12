import { maintenanceQueue } from '@/src/jobs/queues';
import { acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

export async function detectStuckRuns(params: {
  workspaceId?: string;
  runOlderThanMinutes?: number;
  correlationId: string;
}) {
  const lockKey = `scheduler:detect-stuck-runs:${params.workspaceId ?? 'all'}`;
  const lock = await acquireIdempotencyLock(lockKey, 90);
  if (!lock) return { skipped: true, reason: 'lock_not_acquired' as const };

  try {
    await maintenanceQueue.add(
      'detectStuckRuns',
      {
        workspaceId: params.workspaceId ?? 'system',
        runOlderThanMinutes: params.runOlderThanMinutes ?? 30,
        correlationId: params.correlationId,
      },
      {
        jobId: `detect-stuck-runs:${params.workspaceId ?? 'all'}`,
      }
    );

    logger.info('scheduler enqueued stuck run detection', { correlationId: params.correlationId, workspaceId: params.workspaceId ?? 'all' });
    return { queued: true };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}
