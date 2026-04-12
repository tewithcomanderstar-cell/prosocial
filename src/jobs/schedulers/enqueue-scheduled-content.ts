import { workflowTriggerQueue } from '@/src/jobs/queues';
import { prisma } from '@/src/lib/db/prisma';
import { acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

export async function enqueueScheduledContent(params: {
  workspaceId?: string;
  batchSize?: number;
  correlationId: string;
}) {
  const lockKey = `scheduler:scheduled-content:${params.workspaceId ?? 'all'}`;
  const lock = await acquireIdempotencyLock(lockKey, 120);
  if (!lock) return { skipped: true, reason: 'lock_not_acquired' as const };

  try {
    const now = new Date();
    const dueContent = await prisma.contentItem.findMany({
      where: {
        workspaceId: params.workspaceId,
        publishStatus: { in: ['queued', 'retry_scheduled'] },
        scheduledAt: { lte: now },
      },
      take: params.batchSize ?? 100,
      orderBy: { scheduledAt: 'asc' },
      include: { contentDestinations: true },
    });

    for (const content of dueContent) {
      await workflowTriggerQueue.add(
        'enqueueScheduledWorkflowTrigger',
        {
          workspaceId: content.workspaceId,
          workflowId: `publish-now-${content.workspaceId}`,
          workflowRunId: undefined,
          triggerSource: 'schedule',
          triggerFingerprint: `scheduled-content:${content.id}:${content.scheduledAt?.toISOString() ?? 'none'}`,
          correlationId: params.correlationId,
          contentItemId: content.id,
        },
        {
          jobId: `scheduled-content:${content.id}:${content.scheduledAt?.toISOString() ?? 'none'}`,
        }
      );
    }

    logger.info('scheduler enqueued scheduled content', {
      correlationId: params.correlationId,
      workspaceId: params.workspaceId,
      count: dueContent.length,
    });

    return { queued: dueContent.length };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}
