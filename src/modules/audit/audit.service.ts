import { prisma } from '@/src/lib/db/prisma';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { AuditLogDto, AuditRecordContext, CreateAuditLogInput } from './audit.types';

export class AuditLogService {
  async listAuditLogs(context: RequestContext, filters: { entityType?: string; entityId?: string; actorUserId?: string; take?: number }): Promise<AuditLogDto[]> {
    return prisma.auditLog.findMany({
      where: {
        workspaceId: context.workspaceId,
        entityType: filters.entityType,
        entityId: filters.entityId,
        actorUserId: filters.actorUserId,
      },
      take: filters.take ?? 50,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAuditLog(input: CreateAuditLogInput): Promise<AuditLogDto> {
    return prisma.auditLog.create({ data: input });
  }

  async record(input: CreateAuditLogInput): Promise<AuditLogDto> {
    return this.createAuditLog(input);
  }

  async recordContentAction(
    context: AuditRecordContext,
    input: {
      action: string;
      contentItemId: string;
      metadataJson?: unknown;
    }
  ) {
    return this.record({
      workspaceId: context.workspaceId,
      actorUserId: context.actorUserId ?? null,
      actorType: context.actorType ?? 'user',
      action: input.action,
      entityType: 'content_item',
      entityId: input.contentItemId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadataJson: input.metadataJson,
    });
  }

  async recordApprovalDecision(
    context: AuditRecordContext,
    input: {
      action: 'approval.approved' | 'approval.rejected' | 'content.submit_review';
      approvalRequestId: string;
      contentItemId: string;
      comment?: string | null;
      metadataJson?: unknown;
    }
  ) {
    return this.record({
      workspaceId: context.workspaceId,
      actorUserId: context.actorUserId ?? null,
      actorType: context.actorType ?? 'user',
      action: input.action,
      entityType: 'approval_request',
      entityId: input.approvalRequestId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadataJson: {
        contentItemId: input.contentItemId,
        comment: input.comment ?? null,
        ...((input.metadataJson as Record<string, unknown> | null) ?? {}),
      },
    });
  }

  async recordSettingsChange(
    context: AuditRecordContext,
    input: {
      workspaceId: string;
      metadataJson?: unknown;
    }
  ) {
    return this.record({
      workspaceId: input.workspaceId,
      actorUserId: context.actorUserId ?? null,
      actorType: context.actorType ?? 'user',
      action: 'settings.updated',
      entityType: 'workspace_settings',
      entityId: input.workspaceId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadataJson: input.metadataJson,
    });
  }
}
