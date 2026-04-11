import { z } from 'zod';

export const listNotificationsQuerySchema = z.object({
  status: z.enum(['queued', 'sent', 'failed', 'read']).optional(),
  channel: z.enum(['in_app', 'email', 'line', 'slack']).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
});

export const notificationIdParamsSchema = z.object({ id: z.string().cuid() });
