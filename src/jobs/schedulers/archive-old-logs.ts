import { maintenanceQueue } from '@/src/jobs/queues';
import { acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

export async function archiveOldLogs(params: {
  workspaceId?: string;
  retentionDays?: number;
  correlationId: string;
}) {
  const lockKey = `scheduler:archive-old-logs:${params.workspaceId ?? 'all'}`;
  const lock = await acquireIdempotencyLock(lockKey, 300);
  if (!lock) return { skipped: true, reason: 'lock_not_acquired' as const };

  try {
    await maintenanceQueue.add(
      'archiveOldLogs',
      {
        workspaceId: params.workspaceId,
        retentionDays: params.retentionDays ?? 30,
        correlationId: params.correlationId,
      },
      {
        jobId: `archive-old-logs:${params.workspaceId ?? 'all'}`,
      }
    );

    logger.info('scheduler enqueued archive old logs', {
      correlationId: params.correlationId,
      workspaceId: params.workspaceId ?? 'all',
      retentionDays: params.retentionDays ?? 30,
    });
    return { queued: true };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}
