export type SupportedWebhookProvider = 'facebook' | 'google-drive' | 'google-sheets';

export type ProcessFacebookWebhookEventJob = {
  webhookEventId: string;
  provider: 'facebook';
  correlationId: string;
  workspaceId?: string;
};

export type ProcessGoogleDriveWebhookEventJob = {
  webhookEventId: string;
  provider: 'google-drive';
  correlationId: string;
  workspaceId?: string;
};

export type ProcessGoogleSheetsWebhookEventJob = {
  webhookEventId: string;
  provider: 'google-sheets';
  correlationId: string;
  workspaceId?: string;
};

export type NormalizedWebhookEvent = {
  provider: SupportedWebhookProvider;
  eventType: string;
  eventId?: string;
  occurredAt?: string;
  workspaceRef?: string;
  accountRef?: string;
  destinationRef?: string;
  dedupKey: string;
  rawPayload: unknown;
  normalizedPayload: unknown;
};
