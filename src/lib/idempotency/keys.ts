import { randomUUID } from 'crypto';
import { getRedisClient } from '@/src/lib/redis/client';

export async function acquireIdempotencyLock(key: string, ttlSeconds: number) {
  const redis = getRedisClient();
  const token = randomUUID();
  const ok = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
  return ok === 'OK' ? token : null;
}

export async function releaseIdempotencyLock(key: string, token: string) {
  const redis = getRedisClient();
  const current = await redis.get(key);
  if (current === token) {
    await redis.del(key);
  }
}

export function buildPublishLockKey(workspaceId: string, contentDestinationId: string, publishIntentKey: string) {
  return `idempotency:publish:${workspaceId}:${contentDestinationId}:${publishIntentKey}`;
}

export function buildWorkflowTriggerDedupKey(workspaceId: string, workflowId: string, triggerFingerprint: string) {
  return `idempotency:workflow-trigger:${workspaceId}:${workflowId}:${triggerFingerprint}`;
}

export function buildWebhookDedupKey(provider: string, dedupKey: string) {
  return `idempotency:webhook:${provider}:${dedupKey}`;
}

export function buildNotificationDedupKey(workspaceId: string, channel: string, fingerprint: string) {
  return `idempotency:notification:${workspaceId}:${channel}:${fingerprint}`;
}
