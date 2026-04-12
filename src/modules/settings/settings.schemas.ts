import { z } from 'zod';

export const settingsUpdateSchema = z.object({
  approvalRequiredBeforePublish: z.boolean().optional(),
  approvalRequiredBeforeSchedule: z.boolean().optional(),
  allowEditorsToSchedule: z.boolean().optional(),
  allowOperatorsToPublish: z.boolean().optional(),
  postingWindows: z.array(z.object({ day: z.number().int().min(0).max(6), start: z.string(), end: z.string() })).optional(),
  retryPolicy: z.object({ maxAttempts: z.number().int().min(1).max(20), backoffMinutes: z.number().int().min(1).max(1440) }).optional(),
  randomDelaySeconds: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).optional(),
  tokenExpiryAlertThresholdHours: z.number().int().min(1).max(168).optional(),
  maxPublishRetryAttempts: z.number().int().min(1).max(20).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one settings field must be provided' });
