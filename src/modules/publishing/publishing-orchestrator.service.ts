import { prisma } from '@/src/lib/db/prisma';
import { InvariantViolationError } from '@/src/lib/errors';

export type PublishNowInput = {
  workspaceId: string;
  contentItemId: string;
  requestedById: string;
  idempotencyKey?: string;
};

export type PublishIntentDto = {
  accepted: true;
  contentItemId: string;
  publishJobIds: string[];
  workflowRunId: string;
};

export class PublishingOrchestratorService {
  async publishNow(input: PublishNowInput): Promise<PublishIntentDto> {
    const contentItem = await prisma.contentItem.findFirst({
      where: { id: input.contentItemId, workspaceId: input.workspaceId },
      include: { contentDestinations: true },
    });

    if (!contentItem) {
      throw new InvariantViolationError('Content item is not available for publishing');
    }

    if (!contentItem.contentDestinations.length) {
      throw new InvariantViolationError('Content item must target at least one destination before publishing');
    }

    const publishWorkflow = await prisma.workflow.upsert({
      where: {
        id: `publish-now-${input.workspaceId}`,
      },
      update: {
        status: 'active',
        updatedById: input.requestedById,
      },
      create: {
        id: `publish-now-${input.workspaceId}`,
        workspaceId: input.workspaceId,
        name: 'Publish Now',
        description: 'System workflow for immediate publish orchestration.',
        status: 'active',
        triggerType: 'manual',
        configJson: { systemManaged: true },
        createdById: input.requestedById,
        updatedById: input.requestedById,
      },
    });

    const workflowRun = await prisma.workflowRun.create({
      data: {
        workspaceId: input.workspaceId,
        workflowId: publishWorkflow.id,
        contentItemId: contentItem.id,
        triggerType: 'manual',
        triggerSource: 'api.publish-now',
        status: 'queued',
        inputJson: { idempotencyKey: input.idempotencyKey ?? null, requestedById: input.requestedById },
      },
    });

    const jobs = [] as string[];
    for (const target of contentItem.contentDestinations) {
      const job = await prisma.publishJob.create({
        data: {
          workspaceId: input.workspaceId,
          contentDestinationId: target.id,
          workflowRunId: workflowRun.id,
          status: 'queued',
        },
      });
      jobs.push(job.id);
    }

    await prisma.contentItem.update({
      where: { id: contentItem.id },
      data: { publishStatus: 'queued', status: 'scheduled' },
    });

    return {
      accepted: true,
      contentItemId: contentItem.id,
      publishJobIds: jobs,
      workflowRunId: workflowRun.id,
    };
  }
}
