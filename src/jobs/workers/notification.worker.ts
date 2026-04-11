import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import { prisma } from '@/src/lib/db/prisma';
import { createWorker } from '@/src/jobs/queues/queue-factory';
import { queueNames } from '@/src/jobs/queues/queue-names';
import type { SendApprovalReminderJob, SendFailureAlertJob, SendNotificationJob } from '@/src/jobs/contracts/notification.contracts';
import { buildNotificationDedupKey, acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

async function processor(job: Job<SendNotificationJob | SendApprovalReminderJob | SendFailureAlertJob>) {
  const correlationId = (job.data as any).correlationId ?? randomUUID();
  const lockKey = buildNotificationDedupKey(
    (job.data as any).workspaceId ?? 'global',
    (job.data as any).type ?? job.name,
    (job.data as any).notificationId ?? String(job.id)
  );
  const lock = await acquireIdempotencyLock(lockKey, 120);
  if (!lock) {
    logger.info('notification duplicate skipped', { queue: queueNames.notificationQueue, jobId: job.id, correlationId });
    return { skipped: true, correlationId };
  }

  try {
    logger.info('notification job received', { queue: queueNames.notificationQueue, jobId: job.id, correlationId });
    if ('notificationId' in job.data) {
      await prisma.notification.update({ where: { id: job.data.notificationId }, data: { status: 'sent', sentAt: new Date() } });
    }
    return { accepted: true, correlationId };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}

export const notificationWorker = createWorker(queueNames.notificationQueue, processor, { concurrency: 10 });
