import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { exchangeGoogleCode } from "@/lib/services/google-drive";

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

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/google-drive?success=1`);
  } catch {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/google-drive?error=oauth_failed`);
  }
}
