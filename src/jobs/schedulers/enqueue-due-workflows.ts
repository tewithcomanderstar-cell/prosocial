import { workflowTriggerQueue } from '@/src/jobs/queues';
import { prisma } from '@/src/lib/db/prisma';
import { acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

export async function enqueueDueWorkflowTriggers(params: {
  workspaceId?: string;
  batchSize?: number;
  correlationId: string;
}) {
  const lockKey = `scheduler:workflow-triggers:${params.workspaceId ?? 'all'}`;
  const lock = await acquireIdempotencyLock(lockKey, 120);
  if (!lock) return { skipped: true, reason: 'lock_not_acquired' as const };

  try {
    const now = new Date();
    const workflows = await prisma.workflow.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: 'active',
      },
      take: params.batchSize ?? 100,
      orderBy: { updatedAt: 'asc' },
    });

    let queued = 0;
    for (const workflow of workflows) {
      const cadence = (workflow.configJson as Record<string, unknown> | null)?.scheduleCadenceMinutes;
      const cadenceMinutes = typeof cadence === 'number' ? cadence : null;
      if (!cadenceMinutes) continue;

      const lastRun = await prisma.workflowRun.findFirst({
        where: { workflowId: workflow.id },
        orderBy: { createdAt: 'desc' },
      });

      const dueAt = lastRun?.createdAt ? new Date(lastRun.createdAt.getTime() + cadenceMinutes * 60_000) : now;
      if (dueAt > now) continue;

      await workflowTriggerQueue.add(
        'enqueueScheduledWorkflowTrigger',
        {
          workspaceId: workflow.workspaceId,
          workflowId: workflow.id,
          workflowRunId: undefined,
          triggerSource: 'schedule',
          triggerFingerprint: `workflow:${workflow.id}:${dueAt.toISOString()}`,
          correlationId: params.correlationId,
        },
        {
          jobId: `workflow-schedule:${workflow.id}:${dueAt.toISOString()}`,
        }
      );
      queued += 1;
    }

    logger.info('scheduler enqueued workflow triggers', { correlationId: params.correlationId, workspaceId: params.workspaceId, queued });
    return { queued };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}
