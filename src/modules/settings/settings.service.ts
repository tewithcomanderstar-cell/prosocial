import type { RequestContext } from '@/src/lib/auth/request-context';
import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import { AuditLogService } from '@/src/modules/audit/audit.service';
import { assertPermission } from '@/src/modules/rbac/assert';
import { permissions } from '@/src/modules/rbac/permissions';
import type { WorkspaceSettingsDto } from './settings.types';

const fallback: Omit<WorkspaceSettingsDto, 'workspaceId'> = {
  approvalRequiredBeforePublish: true,
  approvalRequiredBeforeSchedule: false,
  allowEditorsToSchedule: true,
  allowOperatorsToPublish: false,
  postingWindows: [],
  retryPolicy: { maxAttempts: 5, backoffMinutes: 15 },
  randomDelaySeconds: { min: 0, max: 0 },
  tokenExpiryAlertThresholdHours: 24,
  maxPublishRetryAttempts: 5,
};

export class SettingsService {
  constructor(private readonly auditLogService = new AuditLogService()) {}

  async getSettings(context: RequestContext): Promise<WorkspaceSettingsDto> {
    await assertPermission(context, permissions.settingsRead);
    const workspace = await prisma.workspace.findUnique({
      where: { id: context.workspaceId },
      select: { id: true, settingsJson: true },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    return {
      workspaceId: workspace.id,
      ...fallback,
      ...((workspace.settingsJson as Partial<WorkspaceSettingsDto> | null) ?? {}),
    };
  }

  async updateSettings(context: RequestContext, input: Partial<WorkspaceSettingsDto>): Promise<WorkspaceSettingsDto> {
    const authorized = await assertPermission(context, permissions.settingsUpdate);
    const current = await this.getSettings(context);
    const next = { ...current, ...input, workspaceId: context.workspaceId };

    await prisma.workspace.update({
      where: { id: context.workspaceId },
      data: {
        settingsJson: next,
      },
    });

    await this.auditLogService.recordSettingsChange(authorized, {
      workspaceId: context.workspaceId,
      metadataJson: {
        previous: current,
        next,
      },
    });

    return next;
  }
}
