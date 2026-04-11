import { z } from 'zod';

export const listDestinationsQuerySchema = z.object({
  platformId: z.string().cuid().optional(),
  accountId: z.string().cuid().optional(),
  status: z.enum(['active', 'inactive', 'permission_error', 'disconnected']).optional(),
  isPaused: z.enum(['true', 'false']).optional(),
});

export const destinationIdParamsSchema = z.object({ id: z.string().cuid() });

export const updateDestinationSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['active', 'inactive', 'permission_error', 'disconnected']).optional(),
  permissionsJson: z.unknown().optional(),
  metadataJson: z.unknown().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one field must be provided' });

export const syncDestinationsSchema = z.object({
  platformId: z.string().cuid().optional(),
  accountIds: z.array(z.string().cuid()).min(1).optional(),
  force: z.boolean().optional(),
});
