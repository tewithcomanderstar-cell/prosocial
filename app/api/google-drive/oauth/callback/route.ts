import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { exchangeGoogleCode } from "@/lib/services/google-drive";
import { logAction, logRouteError } from "@/lib/services/logging";

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");

    if (!code) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/google-drive?error=missing_code`);
    }

    const tokenPayload = await exchangeGoogleCode(code);

    await GoogleDriveConnection.findOneAndUpdate(
      { userId },
      {
        userId,
        accessToken: tokenPayload.access_token,
        refreshToken: tokenPayload.refresh_token,
        connectedAt: new Date(),
        expiresAt: tokenPayload.expires_in ? new Date(Date.now() + tokenPayload.expires_in * 1000) : null,
        tokenStatus: "healthy",
        lastValidatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    await logAction({
      userId,
      type: "auth",
      level: "success",
      message: "Google Drive connected successfully"
    });

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/google-drive?success=1`);
  } catch (error) {
    try {
      const userId = await requireAuth();
      await logAction({
        userId,
        type: "error",
        level: "error",
        message: "Google Drive connection failed",
        metadata: { reason: error instanceof Error ? error.message : "unknown" }
      });
    } catch {}
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/google-drive?error=oauth_failed`);
  }
}

