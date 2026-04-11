import { z } from 'zod';

export const listRunsQuerySchema = z.object({
  workflowId: z.string().cuid().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped']).optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
});

export const runIdParamsSchema = z.object({ id: z.string().cuid() });
