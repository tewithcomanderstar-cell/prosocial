import { prisma } from '@/src/lib/db/prisma';
import { notificationQueue } from '@/src/jobs/queues';
import { acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

export async function sendNotificationDigests(params: {
  workspaceId?: string;
  correlationId: string;
}) {
  const lockKey = `scheduler:notification-digests:${params.workspaceId ?? 'all'}`;
  const lock = await acquireIdempotencyLock(lockKey, 300);
  if (!lock) return { skipped: true, reason: 'lock_not_acquired' as const };

  try {
    const notifications = await prisma.notification.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: 'queued',
        channel: 'in_app',
      },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });

    for (const notification of notifications) {
      await notificationQueue.add(
        'sendNotification',
        {
          workspaceId: notification.workspaceId,
          notificationId: notification.id,
          correlationId: params.correlationId,
        },
        {
          jobId: `notification:${notification.id}`,
        }
      );
    }

    logger.info('scheduler enqueued notification digest batch', { correlationId: params.correlationId, count: notifications.length });
    return { queued: notifications.length };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}
