export async function normalizeGoogleSheetsWebhookEvent(payload: unknown) {
  return {
    provider: 'google-sheets' as const,
    eventType: 'sheets.change',
    dedupKey: JSON.stringify(payload).slice(0, 128),
    rawPayload: payload,
    normalizedPayload: payload,
  };
}
