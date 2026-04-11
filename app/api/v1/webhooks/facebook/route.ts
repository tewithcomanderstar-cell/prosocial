import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { webhookProcessingQueue } from '@/src/jobs/queues';
import { verifyFacebookWebhookSignature } from '@/src/integrations/facebook/webhooks/signature';
import { WebhookService } from '@/src/modules/webhooks/webhook.service';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { ValidationError } from '@/src/lib/errors';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { facebookWebhookEnvelopeSchema } from '@/src/modules/webhooks/webhook.schemas';

const webhookService = new WebhookService();

function headersToRecord(request: NextRequest) {
  return Object.fromEntries(request.headers.entries());
}

export const POST = withRouteHandler(async (request: NextRequest) => {
  const rawBody = await request.text();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    throw new ValidationError('Invalid JSON payload for Facebook webhook');
  }
  const payload = parseOrThrow(facebookWebhookEnvelopeSchema, parsedJson);
  const correlationId = request.headers.get('x-correlation-id') ?? randomUUID();
  const signatureHeader = request.headers.get('x-hub-signature-256') ?? request.headers.get('x-hub-signature');
  const signatureValid = verifyFacebookWebhookSignature(rawBody, signatureHeader, process.env.FACEBOOK_APP_SECRET ?? 'dev-secret');

  const ingestion = await webhookService.ingestWebhookEvent({
    provider: 'facebook',
    eventType: payload.object,
    payloadJson: payload,
    headersJson: headersToRecord(request),
    signatureValid,
    deliveryId: request.headers.get('x-meta-delivery-id'),
    eventKey: payload.object,
  });

  if (signatureValid && !ingestion.duplicate) {
    await webhookProcessingQueue.add(
      'processFacebookWebhookEvent',
      {
        provider: 'facebook',
        webhookEventId: ingestion.webhookEventId,
        correlationId,
      },
      {
        jobId: `facebook-webhook:${ingestion.webhookEventId}`,
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
      signatureValid,
    },
    { status: signatureValid ? 202 : 401 }
  );
});
