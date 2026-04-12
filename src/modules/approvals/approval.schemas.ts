import { z } from 'zod';

export const listApprovalsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  assignedToMe: z.enum(['true', 'false']).optional(),
});

export const approvalIdParamsSchema = z.object({ id: z.string().cuid() });
export const approvalActionSchema = z.object({ comment: z.string().max(2000).optional() });
export const approvalRejectSchema = z.object({ comment: z.string().min(1).max(2000) });
