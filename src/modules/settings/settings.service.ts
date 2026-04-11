import type { RequestContext } from '@/src/lib/auth/request-context';
import type { WorkspaceSettingsDto } from './settings.types';

const fallback: Omit<WorkspaceSettingsDto, 'workspaceId'> = {
  approvalRequired: true,
  postingWindows: [],
  retryPolicy: { maxAttempts: 5, backoffMinutes: 15 },
  randomDelaySeconds: { min: 0, max: 0 },
  tokenValidationHours: 24,
};

const inMemorySettings = new Map<string, WorkspaceSettingsDto>();

export class SettingsService {
  async getSettings(context: RequestContext): Promise<WorkspaceSettingsDto> {
    return inMemorySettings.get(context.workspaceId) ?? { workspaceId: context.workspaceId, ...fallback };
  }

  async updateSettings(context: RequestContext, input: Partial<WorkspaceSettingsDto>): Promise<WorkspaceSettingsDto> {
    const current = await this.getSettings(context);
    const next = { ...current, ...input, workspaceId: context.workspaceId };
    inMemorySettings.set(context.workspaceId, next);
    return next;
  }
}
