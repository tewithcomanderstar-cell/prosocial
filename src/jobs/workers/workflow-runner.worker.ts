import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import { prisma } from '@/src/lib/db/prisma';
import { createWorker } from '@/src/jobs/queues/queue-factory';
import { queueNames } from '@/src/jobs/queues/queue-names';
import type { RunWorkflowJob } from '@/src/jobs/contracts/workflow.contracts';
import { logger } from '@/src/lib/logger/structured-logger';

async function processor(job: Job<RunWorkflowJob>) {
  const correlationId = job.data.correlationId ?? randomUUID();
  logger.info('workflow run started', {
    queue: queueNames.workflowRunnerQueue,
    jobId: job.id,
    correlationId,
    workflowRunId: job.data.workflowRunId,
    workflowId: job.data.workflowId,
  });

  const workflowRun = await prisma.workflowRun.findUnique({
    where: { id: job.data.workflowRunId },
    include: { workflow: { include: { steps: { orderBy: { stepOrder: 'asc' } } } } },
  });

  if (!workflowRun) {
    throw new Error(`Workflow run ${job.data.workflowRunId} not found`);
  }

  await prisma.workflowRun.update({
    where: { id: workflowRun.id },
    data: {
      status: 'running',
      startedAt: workflowRun.startedAt ?? new Date(),
      contextJson: {
        ...((workflowRun.contextJson as Record<string, unknown> | null) ?? {}),
        correlationId,
      },
    },
  });

  await prisma.workflowRunStep.deleteMany({ where: { workflowRunId: workflowRun.id } });

  const steps = workflowRun.workflow.steps;
  if (!steps.length) {
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        outputJson: { message: 'Workflow contains no executable steps yet.' },
      },
    });
    return { succeeded: true, workflowRunId: workflowRun.id, steps: 0 };
  }

  for (const step of steps) {
    await prisma.workflowRunStep.create({
      data: {
        workflowRunId: workflowRun.id,
        workflowStepId: step.id,
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        status: 'succeeded',
        startedAt: new Date(),
        finishedAt: new Date(),
        inputJson: {
          triggerSource: job.data.triggerSource,
          workflowStepConfig: step.configJson,
        },
        outputJson: {
          execution: 'deferred_to_future_phase',
          correlationId,
        },
      },
    });
  }

  await prisma.workflowRun.update({
    where: { id: workflowRun.id },
    data: {
      status: 'succeeded',
      finishedAt: new Date(),
      outputJson: {
        correlationId,
        stepCount: steps.length,
        execution: 'workflow runner skeleton completed',
      },
    },
  });

  return {
    succeeded: true,
    workflowRunId: workflowRun.id,
    stepCount: steps.length,
    correlationId,
  };
}

export const workflowRunnerWorker = createWorker(queueNames.workflowRunnerQueue, processor);
