import { createHash } from 'crypto';
import type { NormalizedWebhookEvent } from '@/src/jobs/contracts/webhook.contracts';

export function normalizeFacebookWebhookEvent(payload: any): NormalizedWebhookEvent[] {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  return entries.flatMap((entry: any) => {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    return changes.map((change: any) => {
      const rawFingerprint = JSON.stringify({ object: payload?.object, entryId: entry?.id, field: change?.field, value: change?.value });
      const dedupKey = createHash('sha256').update(rawFingerprint).digest('hex');
      return {
        provider: 'facebook',
        eventType: change?.field ?? 'unknown',
        eventId: change?.value?.post_id ?? change?.value?.item ?? undefined,
        occurredAt: change?.value?.created_time ? new Date(change.value.created_time * 1000).toISOString() : undefined,
        destinationRef: entry?.id ? String(entry.id) : undefined,
        dedupKey,
        rawPayload: payload,
        normalizedPayload: {
          object: payload?.object,
          pageId: entry?.id,
          field: change?.field,
          value: change?.value,
        },
      } satisfies NormalizedWebhookEvent;
    });
  });
}
