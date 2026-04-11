export const PLATFORM_KEYS = [
  'facebook',
  'instagram',
  'tiktok',
  'linkedin',
  'x',
  'youtube',
  'line',
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export const PLATFORM_STATUS = ['active', 'disabled', 'beta'] as const;
export type PlatformStatus = (typeof PLATFORM_STATUS)[number];

export const ACCOUNT_STATUS = ['connected', 'warning', 'expired', 'disconnected'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUS)[number];

export const DESTINATION_TYPES = ['page', 'group', 'profile', 'channel', 'board'] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const CONTENT_ITEM_STATUS = [
  'draft',
  'pending_review',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'archived',
] as const;
export type ContentItemStatus = (typeof CONTENT_ITEM_STATUS)[number];

export const APPROVAL_STATUS = ['pending', 'approved', 'rejected', 'changes_requested'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

export const WORKFLOW_STATUS = ['draft', 'active', 'paused', 'disabled'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUS)[number];

export const WORKFLOW_RUN_STATUS = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUS)[number];

export const WORKFLOW_TRIGGER_TYPES = [
  'manual',
  'schedule',
  'google_drive_file',
  'google_sheets_row',
  'webhook',
  'retry_failed_publish',
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

export const WORKFLOW_STEP_TYPES = [
  'create_content_item',
  'generate_caption',
  'rewrite_caption',
  'attach_hashtags',
  'validate_content',
  'submit_for_approval',
  'publish_to_destination',
  'notify_team',
  'retry_later',
  'archive_content_item',
] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'line', 'slack'] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNELS)[number];

export interface Platform {
  id: string;
  key: PlatformKey;
  name: string;
  status: PlatformStatus;
}

export interface Account {
  id: string;
  platformId: string;
  userId: string;
  externalAccountId: string;
  displayName: string;
  status: AccountStatus;
  metadata?: Record<string, unknown>;
}

export interface Destination {
  id: string;
  platformId: string;
  accountId: string;
  externalDestinationId: string;
  type: DestinationType;
  name: string;
  status: AccountStatus;
  permissionsJson?: Record<string, unknown>;
  health?: DestinationHealth;
}

export interface DestinationHealth {
  connectionStatus: 'healthy' | 'warning' | 'broken';
  permissionStatus: 'valid' | 'partial' | 'invalid';
  tokenStatus: 'valid' | 'expiring' | 'expired';
  lastSuccessfulPublishAt?: string;
  lastValidatedAt?: string;
  warnings?: string[];
}

export interface Credential {
  id: string;
  platformId: string;
  accountId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopesJson?: string[];
  status: AccountStatus;
  lastValidatedAt?: string;
}

export interface ContentItem {
  id: string;
  workspaceId: string;
  title: string;
  bodyText: string;
  status: ContentItemStatus;
  platformPayloadJson?: Record<string, unknown>;
  createdBy: string;
  scheduledAt?: string;
  publishedAt?: string;
  destinationIds?: string[];
  mediaAssetIds?: string[];
  approvalRequired?: boolean;
}

export interface MediaAsset {
  id: string;
  contentItemId: string;
  type: 'image' | 'video' | 'link';
  url: string;
  metadataJson?: Record<string, unknown>;
  processingStatus: 'pending' | 'ready' | 'failed';
}

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  status: WorkflowStatus;
  triggerType: WorkflowTriggerType;
  configJson?: Record<string, unknown>;
  createdBy: string;
}

export interface WorkflowStep {
  id: string;
  workflowId: string;
  stepOrder: number;
  stepType: WorkflowStepType;
  configJson?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  contentItemId?: string;
  triggerSource: WorkflowTriggerType | string;
  status: WorkflowRunStatus;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  inputJson?: Record<string, unknown>;
  outputJson?: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  contentItemId: string;
  requestedBy: string;
  assignedTo?: string;
  status: ApprovalStatus;
  comment?: string;
  decidedAt?: string;
}

export interface Notification {
  id: string;
  workspaceId: string;
  channel: NotificationChannelType;
  type:
    | 'publish_success'
    | 'publish_failure'
    | 'approval_needed'
    | 'token_expiring'
    | 'workflow_disabled'
    | 'queue_blocked'
    | 'scheduled_publish_missed';
  status: 'pending' | 'sent' | 'failed';
  payloadJson?: Record<string, unknown>;
}

export interface AuditLog {
  id: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadataJson?: Record<string, unknown>;
  createdAt: string;
}
