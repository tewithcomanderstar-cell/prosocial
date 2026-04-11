import { credentialValidationQueue } from '@/src/jobs/queues';
import { CredentialService } from '@/src/modules/credentials/credential.service';
import { acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';

const credentialService = new CredentialService();

export async function validateExpiringCredentials(params: {
  hoursAhead?: number;
  correlationId: string;
}) {
  const lockKey = 'scheduler:validate-expiring-credentials';
  const lock = await acquireIdempotencyLock(lockKey, 120);
  if (!lock) return { skipped: true, reason: 'lock_not_acquired' as const };

  try {
    const credentialIds = await credentialService.listExpiringCredentialIds(params.hoursAhead ?? 24);
    for (const credentialId of credentialIds) {
      await credentialValidationQueue.add(
        'validateCredential',
        {
          workspaceId: 'system',
          credentialId,
          correlationId: params.correlationId,
        },
        {
          jobId: `validate-credential:${credentialId}`,
        }
      );
    }

    logger.info('scheduler enqueued credential validation', { correlationId: params.correlationId, count: credentialIds.length });
    return { queued: credentialIds.length };
  } finally {
    await releaseIdempotencyLock(lockKey, lock);
  }
}
