export async function normalizeGoogleDriveWebhookEvent(payload: unknown) {
  return {
    provider: 'google-drive' as const,
    eventType: 'drive.change',
    dedupKey: JSON.stringify(payload).slice(0, 128),
    rawPayload: payload,
    normalizedPayload: payload,
  };
}
