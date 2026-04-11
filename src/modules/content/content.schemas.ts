import { z } from 'zod';

export const contentIdParamsSchema = z.object({ id: z.string().cuid() });

export const listContentQuerySchema = z.object({
  status: z.enum(['draft', 'pending_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'archived']).optional(),
  reviewStatus: z.enum(['not_required', 'pending', 'approved', 'rejected']).optional(),
  publishStatus: z.enum(['not_scheduled', 'queued', 'publishing', 'published', 'failed', 'retry_scheduled', 'cancelled']).optional(),
  destinationId: z.string().cuid().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
});

export const destinationAssignmentSchema = z.object({
  destinationId: z.string().cuid(),
  scheduledAt: z.coerce.date().optional(),
  platformPayloadJson: z.unknown().optional(),
});

export const createContentSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  bodyText: z.string().max(5000).nullable().optional(),
  sourceType: z.string().max(80).nullable().optional(),
  sourceRef: z.string().max(255).nullable().optional(),
  metadataJson: z.unknown().optional(),
  destinationAssignments: z.array(destinationAssignmentSchema).default([]),
  mediaAssetIds: z.array(z.string().cuid()).default([]),
}).superRefine((value, ctx) => {
  if (!value.title && !value.bodyText) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Either title or bodyText is required' });
  }
  const destinationIds = value.destinationAssignments.map((assignment) => assignment.destinationId);
  if (new Set(destinationIds).size !== destinationIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'destinationAssignments must not contain duplicate destinationId values' });
  }
});

export const updateContentSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  bodyText: z.string().max(5000).nullable().optional(),
  metadataJson: z.unknown().optional(),
  destinationAssignments: z.array(destinationAssignmentSchema).optional(),
  mediaAssetIds: z.array(z.string().cuid()).optional(),
}).superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field must be provided' });
  }
  if (value.destinationAssignments) {
    const destinationIds = value.destinationAssignments.map((assignment) => assignment.destinationId);
    if (new Set(destinationIds).size !== destinationIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'destinationAssignments must not contain duplicate destinationId values' });
    }
  }
});

export const scheduleContentSchema = z.object({
  scheduledAt: z.coerce.date(),
  destinationIds: z.array(z.string().cuid()).min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.scheduledAt.getTime() <= Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scheduledAt must be in the future' });
  }
});

export const reviewActionSchema = z.object({
  comment: z.string().max(2000).optional(),
  assignedToId: z.string().cuid().optional(),
});

export const rejectionSchema = z.object({
  comment: z.string().min(1).max(2000),
});
