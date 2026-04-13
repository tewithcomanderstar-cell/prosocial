import { clearSessionOnResponse, getSessionUserId } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { jsonOk } from "@/lib/api";
import { logAction } from "@/lib/services/logging";
import { NextResponse } from "next/server";

export async function POST() {
  await connectDb();
  const userId = await getSessionUserId();
  const response = NextResponse.json({ ok: true, message: "Logged out", data: {} });
  clearSessionOnResponse(response);

  if (userId) {
    try {
      await logAction({
        userId,
        type: "auth",
        level: "info",
        message: "User logged out"
      });
    } catch (loggingError) {
      console.error("[auth-logout] unable to persist logout log", loggingError);
    }
  }

  return response;
}
