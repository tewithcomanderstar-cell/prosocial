import { z } from 'zod';

export const mediaIdParamsSchema = z.object({ id: z.string().cuid() });

export const createMediaSchema = z.object({
  contentItemId: z.string().cuid().optional(),
  type: z.enum(['image', 'video', 'document']),
  storageKey: z.string().min(1),
  publicUrl: z.string().url(),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  checksum: z.string().optional(),
  metadataJson: z.unknown().optional(),
});
