import { randomUUID } from 'crypto';
import { workflowTriggerQueue } from '@/src/jobs/queues';
import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import { AuditLogService } from '@/src/modules/audit/audit.service';
import { assertPermission } from '@/src/modules/rbac/assert';
import { permissions } from '@/src/modules/rbac/permissions';
import type { WorkflowDto } from './workflow.types';

export class WorkflowService {
  constructor(private readonly auditLogService = new AuditLogService()) {}

  async listWorkflows(context: RequestContext, filters: { status?: string }): Promise<WorkflowDto[]> {
    await assertPermission(context, permissions.workflowRead);
    return prisma.workflow.findMany({
      where: { workspaceId: context.workspaceId, status: filters.status as never },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    }) as Promise<WorkflowDto[]>;
  }

  async getWorkflowById(context: RequestContext, id: string): Promise<WorkflowDto> {
    await assertPermission(context, permissions.workflowRead);
    const workflow = await prisma.workflow.findFirst({
      where: { id, workspaceId: context.workspaceId },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!workflow) throw new NotFoundError('Workflow not found');
    return workflow as WorkflowDto;
  }

  async createWorkflow(context: RequestContext, input: any): Promise<WorkflowDto> {
    const authorized = await assertPermission(context, permissions.workflowCreate);
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
    await this.auditLogService.record({
      workspaceId: context.workspaceId,
      actorUserId: authorized.userId,
      actorType: 'user',
      action: 'workflow.created',
      entityType: 'workflow',
      entityId: workflow.id,
      ipAddress: authorized.ipAddress ?? null,
      userAgent: authorized.userAgent ?? null,
      metadataJson: {
        triggerType: workflow.triggerType,
        stepCount: workflow.steps.length,
      },
    });
    return workflow as WorkflowDto;
  }

  async updateWorkflow(context: RequestContext, id: string, input: any): Promise<WorkflowDto> {
    const authorized = await assertPermission(context, permissions.workflowUpdate);
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
    await this.auditLogService.record({
      workspaceId: context.workspaceId,
      actorUserId: authorized.userId,
      actorType: 'user',
      action: 'workflow.updated',
      entityType: 'workflow',
      entityId: workflow.id,
      ipAddress: authorized.ipAddress ?? null,
      userAgent: authorized.userAgent ?? null,
      metadataJson: {
        updatedFields: Object.keys(input),
      },
    });
    return workflow as WorkflowDto;
  }

  async activateWorkflow(context: RequestContext, id: string): Promise<WorkflowDto> {
    const authorized = await assertPermission(context, permissions.workflowManage);
    const result = await this.updateWorkflow(context, id, { status: 'active' });
    await this.auditLogService.record({
      workspaceId: context.workspaceId,
      actorUserId: authorized.userId,
      actorType: 'user',
      action: 'workflow.activated',
      entityType: 'workflow',
      entityId: id,
      ipAddress: authorized.ipAddress ?? null,
      userAgent: authorized.userAgent ?? null,
    });
    return result;
  }

  async pauseWorkflow(context: RequestContext, id: string): Promise<WorkflowDto> {
    const authorized = await assertPermission(context, permissions.workflowManage);
    const result = await this.updateWorkflow(context, id, { status: 'paused' });
    await this.auditLogService.record({
      workspaceId: context.workspaceId,
      actorUserId: authorized.userId,
      actorType: 'user',
      action: 'workflow.paused',
      entityType: 'workflow',
      entityId: id,
      ipAddress: authorized.ipAddress ?? null,
      userAgent: authorized.userAgent ?? null,
    });
    return result;
  }

  async testRunWorkflow(context: RequestContext, id: string, input: any) {
    const authorized = await assertPermission(context, permissions.workflowRun);
    await this.getWorkflowById(context, id);

    const workflowRun = await prisma.workflowRun.create({
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

    const correlationId = randomUUID();
    await workflowTriggerQueue.add(
      'enqueueManualWorkflowRun',
      {
        workspaceId: context.workspaceId,
        workflowId: id,
        workflowRunId: workflowRun.id,
        triggerSource: 'manual',
        triggerFingerprint: `manual:${workflowRun.id}:${context.idempotencyKey ?? 'default'}`,
        correlationId,
        inputJson: input.inputJson,
      },
      {
        jobId: `manual-workflow:${workflowRun.id}`,
      }
    );

    await this.auditLogService.record({
      workspaceId: context.workspaceId,
      actorUserId: authorized.userId,
      actorType: 'user',
      action: 'workflow.test_run_requested',
      entityType: 'workflow',
      entityId: id,
      ipAddress: authorized.ipAddress ?? null,
      userAgent: authorized.userAgent ?? null,
      metadataJson: {
        workflowRunId: workflowRun.id,
        correlationId,
      },
    });

    return {
      ...workflowRun,
      correlationId,
    };
  }

  async listWorkflowRuns(context: RequestContext, workflowId: string) {
    await assertPermission(context, permissions.runRead);
    await this.getWorkflowById(context, workflowId);
    return prisma.workflowRun.findMany({
      where: { workspaceId: context.workspaceId, workflowId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
