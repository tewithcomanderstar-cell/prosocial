export const permissions = {
  workspaceRead: 'workspace.read',
  workspaceUpdate: 'workspace.update',
  accountRead: 'account.read',
  accountManage: 'account.manage',
  destinationRead: 'destination.read',
  destinationManage: 'destination.manage',
  contentRead: 'content.read',
  contentCreate: 'content.create',
  contentUpdate: 'content.update',
  contentDelete: 'content.delete',
  contentSubmitReview: 'content.submit_review',
  contentApprove: 'content.approve',
  contentPublish: 'content.publish',
  contentSchedule: 'content.schedule',
  workflowRead: 'workflow.read',
  workflowCreate: 'workflow.create',
  workflowUpdate: 'workflow.update',
  workflowRun: 'workflow.run',
  workflowManage: 'workflow.manage',
  runRead: 'run.read',
  runRetry: 'run.retry',
  notificationRead: 'notification.read',
  settingsRead: 'settings.read',
  settingsUpdate: 'settings.update',
  auditRead: 'audit.read',
} as const;

export type Permission = (typeof permissions)[keyof typeof permissions];

export const allPermissions = Object.values(permissions);
