import { Job } from 'bullmq';
import { createWorker } from '@/src/jobs/queues/queue-factory';
import { queueNames } from '@/src/jobs/queues/queue-names';
import { workflowRunnerQueue } from '@/src/jobs/queues';
import type { EnqueueManualWorkflowRunJob, EnqueueScheduledWorkflowTriggerJob, EnqueueWebhookTriggeredWorkflowJob } from '@/src/jobs/contracts/workflow.contracts';
import { buildWorkflowTriggerDedupKey, acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';
import { prisma } from '@/src/lib/db/prisma';

async function processor(job: Job<EnqueueScheduledWorkflowTriggerJob | EnqueueWebhookTriggeredWorkflowJob | EnqueueManualWorkflowRunJob>) {
  const data = job.data;
  const dedupKey = buildWorkflowTriggerDedupKey(data.workspaceId, data.workflowId, data.triggerFingerprint);
  const lock = await acquireIdempotencyLock(dedupKey, 300);
  if (!lock) {
    logger.info('workflow trigger duplicate skipped', { queue: queueNames.workflowTriggerQueue, jobId: job.id, correlationId: data.correlationId, workflowId: data.workflowId });
    return { skipped: true };
  }

  try {
    const workflowRunId =
      data.workflowRunId ??
      (
        await prisma.workflowRun.create({
          data: {
            workspaceId: data.workspaceId,
            workflowId: data.workflowId,
            contentItemId: 'contentItemId' in data ? data.contentItemId ?? null : null,
            triggerType: data.triggerSource,
            triggerSource: `queue.${data.triggerSource}`,
            triggerEventId: 'webhookEventId' in data ? data.webhookEventId : null,
            status: 'queued',
            inputJson: {
              triggerFingerprint: data.triggerFingerprint,
              normalizedEvent: 'normalizedEvent' in data ? data.normalizedEvent ?? null : null,
              inputJson: 'inputJson' in data ? data.inputJson ?? null : null,
            },
          },
        })
      ).id;

    const child = await workflowRunnerQueue.add('runWorkflow', {
      workspaceId: data.workspaceId,
      workflowId: data.workflowId,
      workflowRunId,
      triggerSource: data.triggerSource,
      correlationId: data.correlationId,
      contentItemId: 'contentItemId' in data ? data.contentItemId : undefined,
      webhookEventId: 'webhookEventId' in data ? data.webhookEventId : undefined,
    }, {
      jobId: `run:${data.workflowId}:${data.triggerFingerprint}`,
    });

    logger.info('workflow trigger queued runner', { queue: queueNames.workflowTriggerQueue, jobId: job.id, childJobId: child.id, correlationId: data.correlationId, workflowRunId });
    return { queued: true, childJobId: child.id, workflowRunId };
  } finally {
    await releaseIdempotencyLock(dedupKey, lock);
  }
}

export const workflowTriggerWorker = createWorker(queueNames.workflowTriggerQueue, processor);
