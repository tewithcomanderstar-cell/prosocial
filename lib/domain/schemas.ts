import { z } from 'zod';
import {
  ACCOUNT_STATUS,
  APPROVAL_STATUS,
  CONTENT_ITEM_STATUS,
  DESTINATION_TYPES,
  NOTIFICATION_CHANNELS,
  PLATFORM_KEYS,
  PLATFORM_STATUS,
  WORKFLOW_RUN_STATUS,
  WORKFLOW_STATUS,
  WORKFLOW_STEP_TYPES,
  WORKFLOW_TRIGGER_TYPES,
} from './types';

export const platformSchema = z.object({
  id: z.string(),
  key: z.enum(PLATFORM_KEYS),
  name: z.string().min(1),
  status: z.enum(PLATFORM_STATUS),
});

export const accountSchema = z.object({
  id: z.string(),
  platformId: z.string(),
  userId: z.string(),
  externalAccountId: z.string(),
  displayName: z.string().min(1),
  status: z.enum(ACCOUNT_STATUS),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const destinationSchema = z.object({
  id: z.string(),
  platformId: z.string(),
  accountId: z.string(),
  externalDestinationId: z.string(),
  type: z.enum(DESTINATION_TYPES),
  name: z.string().min(1),
  status: z.enum(ACCOUNT_STATUS),
  permissionsJson: z.record(z.string(), z.unknown()).optional(),
});

export const contentItemSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1),
  bodyText: z.string().default(''),
  status: z.enum(CONTENT_ITEM_STATUS),
  platformPayloadJson: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.string(),
  scheduledAt: z.string().datetime().optional(),
  publishedAt: z.string().datetime().optional(),
  destinationIds: z.array(z.string()).default([]),
  mediaAssetIds: z.array(z.string()).default([]),
  approvalRequired: z.boolean().default(false),
});

export const workflowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1),
  status: z.enum(WORKFLOW_STATUS),
  triggerType: z.enum(WORKFLOW_TRIGGER_TYPES),
  configJson: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.string(),
});

export const workflowStepSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  stepOrder: z.number().int().nonnegative(),
  stepType: z.enum(WORKFLOW_STEP_TYPES),
  configJson: z.record(z.string(), z.unknown()).optional(),
});

export const workflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  contentItemId: z.string().optional(),
  triggerSource: z.string(),
  status: z.enum(WORKFLOW_RUN_STATUS),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  errorMessage: z.string().optional(),
  inputJson: z.record(z.string(), z.unknown()).optional(),
  outputJson: z.record(z.string(), z.unknown()).optional(),
});

export const approvalRequestSchema = z.object({
  id: z.string(),
  contentItemId: z.string(),
  requestedBy: z.string(),
  assignedTo: z.string().optional(),
  status: z.enum(APPROVAL_STATUS),
  comment: z.string().optional(),
  decidedAt: z.string().datetime().optional(),
});

export const notificationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  channel: z.enum(NOTIFICATION_CHANNELS),
  type: z.enum([
    'publish_success',
    'publish_failure',
    'approval_needed',
    'token_expiring',
    'workflow_disabled',
    'queue_blocked',
    'scheduled_publish_missed',
  ]),
  status: z.enum(['pending', 'sent', 'failed']),
  payloadJson: z.record(z.string(), z.unknown()).optional(),
});
