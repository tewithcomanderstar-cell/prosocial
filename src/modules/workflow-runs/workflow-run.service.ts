import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { WorkflowRunDto } from './workflow-run.types';

export class WorkflowRunService {
  async listRuns(context: RequestContext, filters: { workflowId?: string; status?: string; take: number }): Promise<WorkflowRunDto[]> {
    return prisma.workflowRun.findMany({
      where: { workspaceId: context.workspaceId, workflowId: filters.workflowId, status: filters.status as never },
      take: filters.take,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getRunById(context: RequestContext, id: string): Promise<WorkflowRunDto & { steps: unknown[] }> {
    const run = await prisma.workflowRun.findFirst({ where: { id, workspaceId: context.workspaceId }, include: { runSteps: { orderBy: { stepOrder: 'asc' } } } });
    if (!run) throw new NotFoundError('Workflow run not found');
    return { ...run, steps: run.runSteps };
  }
}
