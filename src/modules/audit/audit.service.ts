import { prisma } from '@/src/lib/db/prisma';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { AuditLogDto, AuditRecordContext, CreateAuditLogInput } from './audit.types';

function toPersistableJson(value: unknown): any {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toPersistableJson(item));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toPersistableJson(item)])
    );
  }

  return String(value);
}

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
    return prisma.auditLog.create({
      data: {
        ...input,
        metadataJson:
          input.metadataJson === undefined ? undefined : toPersistableJson(input.metadataJson),
      },
    });
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
