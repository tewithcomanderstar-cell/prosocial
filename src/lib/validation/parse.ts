import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '@/src/lib/errors';

export function parseOrThrow<T>(schema: ZodSchema<T>, payload: unknown): T {
  try {
    return schema.parse(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError('Request validation failed', error.flatten());
    }
    throw error;
  }
}
