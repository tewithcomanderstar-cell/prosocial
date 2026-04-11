import { z } from 'zod';

export const settingsUpdateSchema = z.object({
  approvalRequired: z.boolean().optional(),
  postingWindows: z.array(z.object({ day: z.number().int().min(0).max(6), start: z.string(), end: z.string() })).optional(),
  retryPolicy: z.object({ maxAttempts: z.number().int().min(1).max(20), backoffMinutes: z.number().int().min(1).max(1440) }).optional(),
  randomDelaySeconds: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).optional(),
  tokenValidationHours: z.number().int().min(1).max(168).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one settings field must be provided' });
