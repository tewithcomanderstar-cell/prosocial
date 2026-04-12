import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import { prisma } from '@/src/lib/db/prisma';
import { createWorker } from '@/src/jobs/queues/queue-factory';
import { queueNames } from '@/src/jobs/queues/queue-names';
import type { PublishContentDestinationJob, RetryPublishContentDestinationJob, PublishErrorKind } from '@/src/jobs/contracts/publish.contracts';
import { buildPublishLockKey, acquireIdempotencyLock, releaseIdempotencyLock } from '@/src/lib/idempotency/keys';
import { logger } from '@/src/lib/logger/structured-logger';
import { FacebookPublisher } from '@/src/integrations/facebook/publisher/facebook-publisher';

const publishers = {
  facebook: new FacebookPublisher(),
};

function classifyPublishFailure(error: unknown): { kind: PublishErrorKind; retryable: boolean; message: string } {
  const message = error instanceof Error ? error.message : 'Unknown publish error';
  if (message.includes('rate limit')) return { kind: 'rate_limit_error', retryable: true, message };
  if (message.includes('permission')) return { kind: 'permission_error', retryable: false, message };
  if (message.includes('validation')) return { kind: 'validation_error', retryable: false, message };
  if (message.includes('provider_error_permanent')) return { kind: 'provider_error_permanent', retryable: false, message };
  if (message.includes('provider_error_transient')) return { kind: 'provider_error_transient', retryable: true, message };
  if (message.includes('auth')) return { kind: 'auth_error', retryable: false, message };
  if (message.includes('conflict')) return { kind: 'conflict_error', retryable: false, message };
  if (message.includes('invariant')) return { kind: 'invariant_violation', retryable: false, message };
  return { kind: 'internal_error', retryable: true, message };
}

function computeBackoffMs(attempt: number) {
  const base = Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 60_000 * 60);
  const jitter = Math.floor(Math.random() * 15_000);
  return base + jitter;
}

async function updateContentItemPublishState(contentItemId: string) {
  const statuses = await prisma.contentDestination.findMany({
    where: { contentItemId },
    select: { publishStatus: true },
  });

  if (!statuses.length) return;

  const publishStatuses = statuses.map((item: typeof statuses[number]) => item.publishStatus);
    const nextStatus = publishStatuses.every((status: typeof publishStatuses[number]) => status === 'published')
    ? 'published'
    : publishStatuses.some((status: typeof publishStatuses[number]) => status === 'publishing')
      ? 'publishing'
      : publishStatuses.some((status: typeof publishStatuses[number]) => status === 'retry_scheduled')
        ? 'retry_scheduled'
        : publishStatuses.some((status: typeof publishStatuses[number]) => status === 'failed')
          ? 'failed'
          : publishStatuses.some((status: typeof publishStatuses[number]) => status === 'queued')
            ? 'queued'
            : 'not_scheduled';

  const data: Record<string, unknown> = {
    publishStatus: nextStatus,
  };

  if (nextStatus === 'published') {
    data.status = 'published';
    data.publishedAt = new Date();
  } else if (nextStatus === 'failed') {
    data.status = 'failed';
  } else if (nextStatus === 'publishing') {
    data.status = 'publishing';
  }

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data,
  });
}

async function processor(job: Job<PublishContentDestinationJob | RetryPublishContentDestinationJob>) {
  const data = job.data;
  const correlationId = data.correlationId ?? randomUUID();
  const lockKey = buildPublishLockKey(data.workspaceId, data.contentDestinationId, data.publishIntentKey);
  const lockToken = await acquireIdempotencyLock(lockKey, 300);
  if (!lockToken) {
    logger.warn('publish lock acquisition failed; skipping duplicate runner', { queue: queueNames.publishQueue, jobId: job.id, contentDestinationId: data.contentDestinationId, correlationId });
    return { skipped: true, correlationId };
  }

  try {
    const publishJob = await prisma.publishJob.findFirst({
      where: { contentDestinationId: data.contentDestinationId, workspaceId: data.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        workflowRun: true,
        contentDestination: {
          include: {
            destination: { include: { platform: true, account: { include: { credentials: { orderBy: { updatedAt: 'desc' }, take: 1 } } } } },
            contentItem: { include: { mediaAssets: true } },
          },
        },
      },
    });

    if (!publishJob) throw new Error('validation publish job missing');
    if (publishJob.status === 'succeeded' && publishJob.contentDestination.externalPostId) {
      logger.info('publish already succeeded, treating as idempotent success', { jobId: job.id, publishJobId: publishJob.id, externalPostId: publishJob.contentDestination.externalPostId });
      return { alreadyPublished: true, externalPostId: publishJob.contentDestination.externalPostId };
    }

    await prisma.publishJob.update({ where: { id: publishJob.id }, data: { status: 'running', attemptCount: { increment: 1 }, lockKey } });
    await prisma.contentDestination.update({ where: { id: publishJob.contentDestinationId }, data: { publishStatus: 'publishing' } });
    await updateContentItemPublishState(publishJob.contentDestination.contentItemId);

    const destination = publishJob.contentDestination.destination as any;
    const credential = destination.account.credentials[0] as any;
    const platformKey = destination.platform.key as keyof typeof publishers;
    const publisher = publishers[platformKey];
    if (!publisher) throw new Error(`validation unsupported publisher ${platformKey}`);

    const destinationValidation = await publisher.validateDestination({ destination, credential });
    if (!destinationValidation.isValid) {
      throw new Error(`validation ${destinationValidation.reason ?? 'destination invalid'}`);
    }

    const payload = {
      title: publishJob.contentDestination.contentItem.title,
      bodyText: publishJob.contentDestination.contentItem.bodyText,
      media: publishJob.contentDestination.contentItem.mediaAssets.map((asset: (typeof publishJob.contentDestination.contentItem.mediaAssets)[number]) => ({ publicUrl: asset.publicUrl, type: asset.type, mimeType: asset.mimeType })),
      platformPayload: publishJob.contentDestination.platformPayloadJson,
    };

    const payloadValidation = await publisher.validatePayload({ destination, payload });
    if (!payloadValidation.isValid) {
      throw new Error(`validation ${(payloadValidation.errors ?? []).join(', ')}`);
    }

    const result = await publisher.publish({ destination, credential, payload, correlationId });

    if (!result.success) {
      const errorKind = result.retryable ? 'provider_error_transient' : 'provider_error_permanent';
      throw new Error(`${errorKind} ${result.errorMessage ?? 'publish failed'}`);
    }

    await prisma.contentDestination.update({
      where: { id: publishJob.contentDestinationId },
      data: {
        publishStatus: 'published',
        publishedAt: new Date(),
        externalPostId: result.externalPostId,
        lastError: null,
        platformPayloadJson: {
          ...((publishJob.contentDestination.platformPayloadJson as Record<string, unknown> | null) ?? {}),
          providerResponse: result.rawResponse,
          lastSuccessfulCorrelationId: correlationId,
        },
      },
    });

    await prisma.publishJob.update({
      where: { id: publishJob.id },
      data: {
        status: 'succeeded',
        lastError: null,
        providerErrorCode: null,
      },
    });

    if (publishJob.workflowRunId) {
      await prisma.workflowRun.update({
        where: { id: publishJob.workflowRunId },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          outputJson: {
            ...((publishJob.workflowRun?.outputJson as Record<string, unknown> | null) ?? {}),
            lastPublishedContentDestinationId: publishJob.contentDestinationId,
            correlationId,
          },
        },
      });
    }

    await updateContentItemPublishState(publishJob.contentDestination.contentItemId);

    logger.info('publish succeeded', { queue: queueNames.publishQueue, jobId: job.id, publishJobId: publishJob.id, correlationId, externalPostId: result.externalPostId });
    return { success: true, externalPostId: result.externalPostId, correlationId };
  } catch (error) {
    const failure = classifyPublishFailure(error);
    const publishJob = await prisma.publishJob.findFirst({
      where: { contentDestinationId: data.contentDestinationId, workspaceId: data.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { contentDestination: true, workflowRun: true },
    });
    if (publishJob) {
      const attemptCount = publishJob.attemptCount + 1;
      const shouldRetry = failure.retryable && attemptCount < publishJob.maxAttempts;
      await prisma.publishJob.update({
        where: { id: publishJob.id },
        data: {
          status: shouldRetry ? 'retry_scheduled' : 'failed',
          nextAttemptAt: shouldRetry ? new Date(Date.now() + computeBackoffMs(attemptCount)) : null,
          lastError: failure.message,
          providerErrorCode: failure.kind,
        },
      });
      await prisma.contentDestination.update({
        where: { id: publishJob.contentDestinationId },
        data: { publishStatus: shouldRetry ? 'retry_scheduled' : 'failed', lastError: failure.message },
      });
      await updateContentItemPublishState(publishJob.contentDestination.contentItemId);
      if (publishJob.workflowRunId) {
        await prisma.workflowRun.update({
          where: { id: publishJob.workflowRunId },
          data: {
            status: shouldRetry ? 'running' : 'failed',
            errorCode: failure.kind,
            errorMessage: failure.message,
            finishedAt: shouldRetry ? null : new Date(),
          },
        });
      }
    }
    logger.error('publish failed', { queue: queueNames.publishQueue, jobId: job.id, correlationId, errorKind: failure.kind, retryable: failure.retryable, message: failure.message });
    throw error;
  } finally {
    await releaseIdempotencyLock(lockKey, lockToken);
  }
}

export const publishWorker = createWorker(queueNames.publishQueue, processor, { concurrency: 5 });
