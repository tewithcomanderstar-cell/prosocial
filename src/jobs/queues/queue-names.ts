export const queueNames = {
  workflowTriggerQueue: 'workflow-trigger',
  workflowRunnerQueue: 'workflow-runner',
  publishQueue: 'publish',
  notificationQueue: 'notification',
  webhookProcessingQueue: 'webhook-processing',
  credentialValidationQueue: 'credential-validation',
  maintenanceQueue: 'maintenance',
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];
