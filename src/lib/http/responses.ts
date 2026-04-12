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

export function withRouteHandler<H extends (request: NextRequest, ...args: any[]) => Promise<Response>>(handler: H): H {
  return (async (request: NextRequest, ...args: Parameters<H> extends [NextRequest, ...infer Rest] ? Rest : never) => {
    try {
      return await handler(request, ...args);
    } catch (error) {
      return apiError(error);
    }
  }) as H;
}
