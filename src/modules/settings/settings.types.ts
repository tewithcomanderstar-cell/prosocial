export type WorkspaceSettingsDto = {
  workspaceId: string;
  approvalRequired: boolean;
  postingWindows: unknown[];
  retryPolicy: { maxAttempts: number; backoffMinutes: number };
  randomDelaySeconds: { min: number; max: number };
  tokenValidationHours: number;
};
