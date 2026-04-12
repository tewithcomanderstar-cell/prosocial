import { createHash, randomUUID } from 'crypto';
import { prisma } from '@/src/lib/db/prisma';
import { ConflictError } from '@/src/lib/errors';
import { normalizeFacebookWebhookEvent } from '@/src/integrations/facebook/webhooks/normalize';
import { normalizeGoogleDriveWebhookEvent } from '@/src/integrations/google-drive/normalize';
import { normalizeGoogleSheetsWebhookEvent } from '@/src/integrations/google-sheets/normalize';
import type { NormalizedWebhookEvent, SupportedWebhookProvider } from '@/src/jobs/contracts/webhook.contracts';

export type IngestWebhookInput = {
  provider: SupportedWebhookProvider;
  workspaceId?: string | null;
  platformId?: string | null;
  eventType: string;
  payloadJson: unknown;
  headersJson?: unknown;
  signatureValid: boolean;
  deliveryId?: string | null;
  eventKey?: string | null;
};

export class WebhookService {
  async ingestWebhookEvent(input: IngestWebhookInput) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ provider: input.provider, deliveryId: input.deliveryId, eventType: input.eventType, payload: input.payloadJson }))
      .digest('hex');

    try {
      const event = await prisma.webhookEvent.create({
        data: {
          workspaceId: input.workspaceId ?? null,
          platformId: input.platformId ?? null,
          provider: input.provider,
          eventType: input.eventType,
          eventKey: input.eventKey ?? null,
          deliveryId: input.deliveryId ?? null,
          signatureValid: input.signatureValid,
          payloadJson: input.payloadJson as any,
          headersJson: input.headersJson as any,
          dedupKey: fingerprint,
          processingStatus: input.signatureValid ? 'received' : 'invalid_signature',
          receivedAt: new Date(),
        },
      });

      return {
        accepted: true as const,
        duplicate: false,
        webhookEventId: event.id,
        correlationId: randomUUID(),
      };
    } catch {
      const existing = await prisma.webhookEvent.findFirst({ where: { provider: input.provider, dedupKey: fingerprint } });
      if (!existing) throw new ConflictError('Unable to persist webhook event');
      return {
        accepted: true as const,
        duplicate: true,
        webhookEventId: existing.id,
        correlationId: randomUUID(),
      };
    }
  }

  async loadAndNormalize(webhookEventId: string): Promise<NormalizedWebhookEvent[] | NormalizedWebhookEvent> {
    const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event) throw new ConflictError('Webhook event not found');

    switch (event.provider) {
      case 'facebook':
        return normalizeFacebookWebhookEvent(event.payloadJson);
      case 'google-drive':
        return normalizeGoogleDriveWebhookEvent(event.payloadJson);
      case 'google-sheets':
        return normalizeGoogleSheetsWebhookEvent(event.payloadJson);
      default:
        throw new ConflictError(`Unsupported webhook provider: ${event.provider}`);
    }
  }

  async markProcessing(webhookEventId: string) {
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processingStatus: 'processing' } });
  }

  async markProcessed(webhookEventId: string) {
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processingStatus: 'processed', processedAt: new Date(), errorMessage: null } });
  }

  async markFailed(webhookEventId: string, errorMessage: string) {
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processingStatus: 'failed', errorMessage } });
  }

  async markQueued(webhookEventId: string) {
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processingStatus: 'queued', errorMessage: null } });
  }
}
