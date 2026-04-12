export type SendNotificationJob = {
  workspaceId: string;
  notificationId: string;
  channel?: 'in_app' | 'email' | 'line' | 'slack';
  dedupFingerprint?: string;
  correlationId: string;
  type?: string;
};

export type SendApprovalReminderJob = {
  workspaceId: string;
  approvalRequestId: string;
  assignedToUserId?: string;
  correlationId: string;
};

export type SendFailureAlertJob = {
  workspaceId: string;
  severity: 'warning' | 'error' | 'critical';
  subject: string;
  entityType: string;
  entityId: string;
  correlationId: string;
};
