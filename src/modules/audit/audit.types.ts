export type AuditLogDto = {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadataJson: unknown;
  createdAt: Date;
};

export type CreateAuditLogInput = {
  workspaceId: string;
  actorUserId?: string | null;
  actorType: 'user' | 'system' | 'job' | 'webhook';
  action: string;
  entityType: string;
  entityId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadataJson?: unknown;
};
