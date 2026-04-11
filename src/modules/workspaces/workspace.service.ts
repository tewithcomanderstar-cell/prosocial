import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { WorkspaceDto } from './workspace.types';
import type { z } from 'zod';
import type { updateWorkspaceSchema } from './workspace.schemas';

export class WorkspaceService {
  async getCurrentWorkspace(context: RequestContext): Promise<WorkspaceDto> {
    const workspace = await prisma.workspace.findUnique({ where: { id: context.workspaceId } });
    if (!workspace) throw new NotFoundError('Workspace not found');
    return workspace;
  }

  async updateCurrentWorkspace(context: RequestContext, input: z.infer<typeof updateWorkspaceSchema>): Promise<WorkspaceDto> {
    const workspace = await prisma.workspace.update({
      where: { id: context.workspaceId },
      data: input,
    });
    return workspace;
  }
}
