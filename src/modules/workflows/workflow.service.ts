import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { WorkflowDto } from './workflow.types';

export class WorkflowService {
  async listWorkflows(context: RequestContext, filters: { status?: string }): Promise<WorkflowDto[]> {
    return prisma.workflow.findMany({
      where: { workspaceId: context.workspaceId, status: filters.status as never },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    }) as Promise<WorkflowDto[]>;
  }

  async getWorkflowById(context: RequestContext, id: string): Promise<WorkflowDto> {
    const workflow = await prisma.workflow.findFirst({
      where: { id, workspaceId: context.workspaceId },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!workflow) throw new NotFoundError('Workflow not found');
    return workflow as WorkflowDto;
  }

  async createWorkflow(context: RequestContext, input: any): Promise<WorkflowDto> {
    const workflow = await prisma.workflow.create({
      data: {
        workspaceId: context.workspaceId,
        name: input.name,
        description: input.description,
        triggerType: input.triggerType,
        configJson: input.configJson,
        createdById: context.userId,
        updatedById: context.userId,
        steps: {
          create: input.steps.map((step: any) => ({
            stepOrder: step.stepOrder,
            stepType: step.stepType,
            stepKey: step.stepKey,
            configJson: step.configJson,
          })),
        },
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    return workflow as WorkflowDto;
  }

  async updateWorkflow(context: RequestContext, id: string, input: any): Promise<WorkflowDto> {
    await this.getWorkflowById(context, id);
    if (input.steps) {
      await prisma.workflowStep.deleteMany({ where: { workflowId: id } });
      await prisma.workflowStep.createMany({
        data: input.steps.map((step: any) => ({ workflowId: id, stepOrder: step.stepOrder, stepType: step.stepType, stepKey: step.stepKey, configJson: step.configJson })),
      });
    }

    const workflow = await prisma.workflow.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        triggerType: input.triggerType,
        configJson: input.configJson,
        status: input.status,
        updatedById: context.userId,
        version: { increment: 1 },
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    return workflow as WorkflowDto;
  }

  async activateWorkflow(context: RequestContext, id: string): Promise<WorkflowDto> {
    return this.updateWorkflow(context, id, { status: 'active' });
  }

  async pauseWorkflow(context: RequestContext, id: string): Promise<WorkflowDto> {
    return this.updateWorkflow(context, id, { status: 'paused' });
  }

  async testRunWorkflow(context: RequestContext, id: string, input: any) {
    await this.getWorkflowById(context, id);
    return prisma.workflowRun.create({
      data: {
        workspaceId: context.workspaceId,
        workflowId: id,
        contentItemId: input.contentItemId,
        triggerType: 'manual',
        triggerSource: 'api.test-run',
        status: 'queued',
        inputJson: input.inputJson,
        contextJson: input.contextJson,
      },
    });
  }

  async listWorkflowRuns(context: RequestContext, workflowId: string) {
    await this.getWorkflowById(context, workflowId);
    return prisma.workflowRun.findMany({
      where: { workspaceId: context.workspaceId, workflowId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
