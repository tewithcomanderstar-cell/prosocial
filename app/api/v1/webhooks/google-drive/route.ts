import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { webhookProcessingQueue } from '@/src/jobs/queues';
import { WebhookService } from '@/src/modules/webhooks/webhook.service';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { ValidationError } from '@/src/lib/errors';

const webhookService = new WebhookService();

function headersToRecord(request: NextRequest) {
  return Object.fromEntries(request.headers.entries());
}

export const POST = withRouteHandler(async (request: NextRequest) => {
  const correlationId = request.headers.get('x-correlation-id') ?? randomUUID();
  const rawBody = await request.text();
  let payload: unknown = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new ValidationError('Invalid JSON payload for Google Drive webhook');
  }

  const ingestion = await webhookService.ingestWebhookEvent({
    provider: 'google-drive',
    eventType: request.headers.get('x-goog-resource-state') ?? 'resource_changed',
    payloadJson: payload,
    headersJson: headersToRecord(request),
    signatureValid: true,
    deliveryId: request.headers.get('x-goog-message-number'),
    eventKey: request.headers.get('x-goog-resource-id'),
  });

  if (!ingestion.duplicate) {
    await webhookProcessingQueue.add(
      'processGoogleDriveWebhookEvent',
      {
        provider: 'google-drive',
        webhookEventId: ingestion.webhookEventId,
        correlationId,
      },
      {
        jobId: `google-drive-webhook:${ingestion.webhookEventId}`,
      }
    );
    await webhookService.markQueued(ingestion.webhookEventId);
  }

  return apiOk(
    {
      accepted: true,
      duplicate: ingestion.duplicate,
      webhookEventId: ingestion.webhookEventId,
      correlationId,
    },
    { status: 202 }
  );
});
