import { z } from 'zod';

export const listAccountsQuerySchema = z.object({
  platformId: z.string().cuid().optional(),
  status: z.enum(['active', 'inactive', 'permission_error', 'disconnected', 'needs_reconnect']).optional(),
});

export const validateAccountParamsSchema = z.object({
  id: z.string().cuid(),
});
