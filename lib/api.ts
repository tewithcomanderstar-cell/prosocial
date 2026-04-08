import { NextResponse } from "next/server";
import { z } from "zod";
import { connectDb } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

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

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, message }, { status });
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown) {
  return schema.parse(body);
}
