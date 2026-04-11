import { z } from 'zod';

export const facebookWebhookHeadersSchema = z.object({
  'x-hub-signature-256': z.string().optional(),
  'x-hub-signature': z.string().optional(),
  'x-meta-delivery-id': z.string().optional(),
});

export const genericWebhookHeadersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

export const facebookWebhookEnvelopeSchema = z.object({
  object: z.string(),
  entry: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const googleDriveWebhookHeadersSchema = z.object({
  'x-goog-channel-id': z.string().optional(),
  'x-goog-resource-id': z.string().optional(),
  'x-goog-resource-state': z.string().optional(),
  'x-goog-message-number': z.string().optional(),
  'x-goog-channel-token': z.string().optional(),
});

export const googleSheetsWebhookHeadersSchema = z.object({
  'x-goog-channel-id': z.string().optional(),
  'x-goog-resource-id': z.string().optional(),
  'x-goog-resource-state': z.string().optional(),
  'x-goog-message-number': z.string().optional(),
  'x-goog-channel-token': z.string().optional(),
});

export const webhookReplaySchema = z.object({
  webhookEventId: z.string().min(1),
});
