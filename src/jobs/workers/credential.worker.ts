import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import { prisma } from '@/src/lib/db/prisma';
import { createWorker } from '@/src/jobs/queues/queue-factory';
import { queueNames } from '@/src/jobs/queues/queue-names';
import type { RefreshDestinationMetadataJob, ValidateCredentialJob } from '@/src/jobs/contracts/maintenance.contracts';
import { CredentialService } from '@/src/modules/credentials/credential.service';
import { logger } from '@/src/lib/logger/structured-logger';

const credentialService = new CredentialService();

async function processor(job: Job<ValidateCredentialJob | RefreshDestinationMetadataJob>) {
  const correlationId = job.data.correlationId ?? randomUUID();
  logger.info('credential worker job received', { queue: queueNames.credentialValidationQueue, jobId: job.id, correlationId, data: job.data });

  if ('credentialId' in job.data) {
    const result = await credentialService.validateCredential(
      {
        userId: 'system',
        workspaceId: job.data.workspaceId,
        roles: ['owner'],
      },
      job.data.credentialId
    );

    await prisma.credential.update({
      where: { id: job.data.credentialId },
      data: { lastValidatedAt: new Date() },
    });

    return { accepted: true, validation: result, correlationId };
  }

  return {
    accepted: true,
    destinationId: job.data.destinationId,
    execution: 'refresh_destination_metadata_deferred',
    correlationId,
  };
}

export const credentialWorker = createWorker(queueNames.credentialValidationQueue, processor, { concurrency: 5 });
