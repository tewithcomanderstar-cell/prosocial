import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { FacebookConnection } from "@/models/FacebookConnection";
import { connectDb } from "@/lib/db";
import { exchangeFacebookCode, fetchFacebookPages } from "@/lib/services/facebook";

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");

    if (!code) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/facebook?error=missing_code`);
    }

    const tokenPayload = await exchangeFacebookCode(code);
    const pages = await fetchFacebookPages(tokenPayload.access_token);

    await FacebookConnection.findOneAndUpdate(
      { userId },
      {
        userId,
        accessToken: tokenPayload.access_token,
        pages,
        connectedAt: new Date(),
        expiresAt: tokenPayload.expires_in ? new Date(Date.now() + tokenPayload.expires_in * 1000) : null,
        tokenStatus: "healthy",
        lastValidatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/facebook?success=1`);
  } catch {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/facebook?error=oauth_failed`);
  }
}
