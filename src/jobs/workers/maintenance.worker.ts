import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import { prisma } from '@/src/lib/db/prisma';
import { createWorker } from '@/src/jobs/queues/queue-factory';
import { queueNames } from '@/src/jobs/queues/queue-names';
import type { ArchiveOldLogsJob, DetectStuckRunsJob, RequeueRetryablePublishJobsJob } from '@/src/jobs/contracts/maintenance.contracts';
import { logger } from '@/src/lib/logger/structured-logger';
import { publishQueue } from '@/src/jobs/queues';

async function processor(job: Job<DetectStuckRunsJob | ArchiveOldLogsJob | RequeueRetryablePublishJobsJob>) {
  const correlationId = job.data.correlationId ?? randomUUID();
  logger.info('maintenance job received', { queue: queueNames.maintenanceQueue, jobId: job.id, correlationId, data: job.data });

  if ('runOlderThanMinutes' in job.data) {
    const cutoff = new Date(Date.now() - job.data.runOlderThanMinutes * 60_000);
    const stuckRuns = await prisma.workflowRun.findMany({
      where: {
        workspaceId: job.data.workspaceId,
        status: 'running',
        startedAt: { lte: cutoff },
      },
      take: 200,
      orderBy: { startedAt: 'asc' },
    });

    for (const run of stuckRuns) {
      await prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorCode: 'internal_error',
          errorMessage: 'Marked as stuck by maintenance job',
          finishedAt: new Date(),
        },
      });
    }

    return { markedStuck: stuckRuns.length, correlationId };
  }

  if ('retentionDays' in job.data) {
    const cutoff = new Date(Date.now() - job.data.retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await prisma.auditLog.deleteMany({
      where: {
        workspaceId: job.data.workspaceId,
        createdAt: { lt: cutoff },
      },
    });
    return { archivedAuditLogs: deleted.count, correlationId };
  }

  if ('dueBefore' in job.data) {
    const due = new Date(job.data.dueBefore);
    const retryable = await prisma.publishJob.findMany({
      where: { status: 'retry_scheduled', nextAttemptAt: { lte: due } },
      take: 100,
      orderBy: { nextAttemptAt: 'asc' },
    });
    for (const item of retryable) {
      await publishQueue.add('retryPublishContentDestination', {
        workspaceId: item.workspaceId,
        contentDestinationId: item.contentDestinationId,
        workflowRunId: item.workflowRunId ?? undefined,
        publishIntentKey: item.id,
        priorPublishJobId: item.id,
        retryReason: 'provider_error_transient',
        correlationId,
      }, { jobId: `retry:${item.id}:${item.attemptCount}` });
    }
    return { requeued: retryable.length, correlationId };
  }

  return { accepted: true, correlationId };
}

export const maintenanceWorker = createWorker(queueNames.maintenanceQueue, processor, { concurrency: 2 });
