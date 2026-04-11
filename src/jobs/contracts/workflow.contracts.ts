export type WorkflowTriggerSource = 'manual' | 'schedule' | 'webhook' | 'retry_failed_post';

export type EnqueueScheduledWorkflowTriggerJob = {
  workspaceId: string;
  workflowId: string;
  workflowRunId?: string;
  triggerSource: 'schedule';
  triggerFingerprint: string;
  correlationId: string;
  scheduledAt?: string;
  contentItemId?: string;
};

export type EnqueueWebhookTriggeredWorkflowJob = {
  workspaceId: string;
  workflowId: string;
  workflowRunId?: string;
  triggerSource: 'webhook';
  webhookEventId: string;
  triggerFingerprint: string;
  correlationId: string;
  normalizedEvent?: unknown;
};

export type EnqueueManualWorkflowRunJob = {
  workspaceId: string;
  workflowId: string;
  triggerSource: 'manual';
  workflowRunId?: string;
  triggerFingerprint: string;
  correlationId: string;
  requestedById?: string;
  inputJson?: unknown;
};

export type RunWorkflowJob = {
  workspaceId: string;
  workflowRunId: string;
  workflowId: string;
  triggerSource: WorkflowTriggerSource;
  correlationId: string;
  contentItemId?: string;
  webhookEventId?: string;
};
