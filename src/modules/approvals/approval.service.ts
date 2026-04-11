import { prisma } from '@/src/lib/db/prisma';
import { ConflictError, NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import { ContentService } from '@/src/modules/content/content.service';
import type { ApprovalRequestDto } from './approval.types';

export class ApprovalService {
  constructor(private readonly contentService = new ContentService()) {}

  async listApprovals(context: RequestContext, filters: { status?: string; assignedToMe?: string }): Promise<ApprovalRequestDto[]> {
    return prisma.approvalRequest.findMany({
      where: {
        workspaceId: context.workspaceId,
        status: filters.status as never,
        assignedToId: filters.assignedToMe === 'true' ? context.userId : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getApprovalById(context: RequestContext, id: string): Promise<ApprovalRequestDto> {
    const approval = await prisma.approvalRequest.findFirst({ where: { id, workspaceId: context.workspaceId } });
    if (!approval) throw new NotFoundError('Approval request not found');
    return approval;
  }

  async approve(context: RequestContext, id: string, input: { comment?: string }) {
    const approval = await this.getApprovalById(context, id);
    if (approval.status !== 'pending') throw new ConflictError('Approval request is no longer pending');
    await prisma.approvalRequest.update({ where: { id }, data: { status: 'approved', decision: 'approved', comment: input.comment, decidedAt: new Date() } });
    return this.contentService.approveContent(context, approval.contentItemId, input);
  }

  async reject(context: RequestContext, id: string, input: { comment: string }) {
    const approval = await this.getApprovalById(context, id);
    if (approval.status !== 'pending') throw new ConflictError('Approval request is no longer pending');
    await prisma.approvalRequest.update({ where: { id }, data: { status: 'rejected', decision: 'rejected', comment: input.comment, decidedAt: new Date() } });
    return this.contentService.rejectContent(context, approval.contentItemId, input);
  }
}
