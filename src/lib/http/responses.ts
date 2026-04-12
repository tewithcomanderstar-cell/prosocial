import { NextRequest, NextResponse } from 'next/server';
import { AppError, InternalServerError } from '@/src/lib/errors';

export type ApiSuccessResponse<T> = {
  data: T;
  meta?: Record<string, unknown>;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function apiOk<T>(data: T, init?: ResponseInit, meta?: Record<string, unknown>) {
  return NextResponse.json({ data, meta } satisfies ApiSuccessResponse<T>, init);
}

export function apiNoContent() {
  return new NextResponse(null, { status: 204 });
}

export function apiError(error: unknown) {
  const normalized = error instanceof AppError ? error : new InternalServerError('Unexpected server error');
  return NextResponse.json(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    } satisfies ApiErrorResponse,
    { status: normalized.statusCode }
  );
}

export function withRouteHandler<T>(handler: (request: NextRequest, ctx?: T) => Promise<Response>) {
  return async (request: NextRequest, ctx?: T) => {
    try {
      return await handler(request, ctx);
    } catch (error) {
      return apiError(error);
    }
  };
}
