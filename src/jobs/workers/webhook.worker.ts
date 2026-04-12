import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import { workflowTriggerQueue } from '@/src/jobs/queues';
import { createWorker } from '@/src/jobs/queues/queue-factory';
import { queueNames } from '@/src/jobs/queues/queue-names';
import type { ProcessFacebookWebhookEventJob, ProcessGoogleDriveWebhookEventJob, ProcessGoogleSheetsWebhookEventJob } from '@/src/jobs/contracts/webhook.contracts';
import { WebhookService } from '@/src/modules/webhooks/webhook.service';
import { logger } from '@/src/lib/logger/structured-logger';

const webhookService = new WebhookService();

async function processor(job: Job<ProcessFacebookWebhookEventJob | ProcessGoogleDriveWebhookEventJob | ProcessGoogleSheetsWebhookEventJob>) {
  const correlationId = job.data.correlationId ?? randomUUID();
  logger.info('webhook processing started', { queue: queueNames.webhookProcessingQueue, jobId: job.id, correlationId, webhookEventId: job.data.webhookEventId, provider: job.data.provider });
  await webhookService.markProcessing(job.data.webhookEventId);
  try {
    const normalized = await webhookService.loadAndNormalize(job.data.webhookEventId);
    const events = Array.isArray(normalized) ? normalized : [normalized];

    for (const event of events) {
      const workspaceId = event.workspaceRef ?? job.data.workspaceId;
      if (!workspaceId) {
        logger.warn('webhook event missing workspace mapping; skipping downstream trigger', {
          queue: queueNames.webhookProcessingQueue,
          jobId: job.id,
          correlationId,
          webhookEventId: job.data.webhookEventId,
          provider: job.data.provider,
          dedupKey: event.dedupKey,
        });
        continue;
      }

      await workflowTriggerQueue.add(
        'enqueueWebhookTriggeredWorkflow',
        {
          workspaceId,
          workflowId: event.eventType,
          workflowRunId: undefined,
          triggerSource: 'webhook',
          triggerFingerprint: event.dedupKey,
          correlationId,
          webhookEventId: job.data.webhookEventId,
          normalizedEvent: event,
        },
        {
          jobId: `webhook-trigger:${event.dedupKey}`,
        }
      );
    }

    await webhookService.markProcessed(job.data.webhookEventId);
    return { processed: true, normalizedCount: events.length, correlationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown webhook processing error';
    await webhookService.markFailed(job.data.webhookEventId, message);
    logger.error('webhook processing failed', { queue: queueNames.webhookProcessingQueue, jobId: job.id, correlationId, webhookEventId: job.data.webhookEventId, message });
    throw error;
  }
}

export const webhookWorker = createWorker(queueNames.webhookProcessingQueue, processor, { concurrency: 20 });
