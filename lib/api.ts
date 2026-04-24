import { NextResponse } from "next/server";
import { z } from "zod";
import { connectDb } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export class RouteError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code?: string
  ) {
    super(message);
    this.name = "RouteError";
  }
}

export class ValidationError extends RouteError {
  constructor(public readonly issues: z.ZodIssue[], message?: string) {
    super(message ?? issues[0]?.message ?? "Invalid request body", 422, "validation_error");
    this.name = "ValidationError";
  }
}

export async function requireAuth() {
  await connectDb();
  const userId = await getSessionUserId();
  if (!userId) {
    throw new Error("UNAUTHORIZED");
  }
  return userId;
}

export function jsonOk<T>(data: T, message?: string) {
  return NextResponse.json({ ok: true, message, data });
}

export function jsonError(message: string, status = 400, code?: string) {
  return NextResponse.json({ ok: false, message, code }, { status });
}

export function isUnauthorizedError(error: unknown) {
  return error instanceof Error && error.message === "UNAUTHORIZED";
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }

  return result.data;
}

export function normalizeRouteError(error: unknown, fallbackMessage = "Unable to complete request") {
  if (isUnauthorizedError(error)) {
    return {
      status: 401,
      message: "Unauthorized",
      code: "unauthorized"
    };
  }

  if (error instanceof ValidationError) {
    return {
      status: error.status,
      message: error.issues[0]?.message ?? error.message,
      code: error.code
    };
  }

  if (error instanceof RouteError) {
    return {
      status: error.status,
      message: error.message,
      code: error.code
    };
  }

  return {
    status: 500,
    message: fallbackMessage,
    code: "internal_error"
  };
}
