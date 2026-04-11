import { prisma } from '@/src/lib/db/prisma';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { AuditLogDto, CreateAuditLogInput } from './audit.types';

export class AuditLogService {
  async listAuditLogs(context: RequestContext, filters: { entityType?: string; entityId?: string; actorUserId?: string; take: number }): Promise<AuditLogDto[]> {
    return prisma.auditLog.findMany({
      where: {
        workspaceId: context.workspaceId,
        entityType: filters.entityType,
        entityId: filters.entityId,
        actorUserId: filters.actorUserId,
      },
      take: filters.take,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAuditLog(input: CreateAuditLogInput): Promise<AuditLogDto> {
    return prisma.auditLog.create({ data: input });
  }
}
