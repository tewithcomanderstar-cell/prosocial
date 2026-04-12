export type WorkspaceSettingsDto = {
  workspaceId: string;
  approvalRequiredBeforePublish: boolean;
  approvalRequiredBeforeSchedule: boolean;
  allowEditorsToSchedule: boolean;
  allowOperatorsToPublish: boolean;
  postingWindows: unknown[];
  retryPolicy: { maxAttempts: number; backoffMinutes: number };
  randomDelaySeconds: { min: number; max: number };
  tokenExpiryAlertThresholdHours: number;
  maxPublishRetryAttempts: number;
};
