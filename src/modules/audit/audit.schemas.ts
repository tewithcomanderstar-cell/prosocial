import { z } from 'zod';

export const auditLogQuerySchema = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  actorUserId: z.string().cuid().optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
});
