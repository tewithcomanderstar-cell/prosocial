import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { exchangeGoogleCode } from "@/lib/services/google-drive";
import { logAction } from "@/lib/services/logging";

const GOOGLE_DRIVE_STATE_COOKIE = "google_drive_oauth_state";
const GOOGLE_DRIVE_REDIRECT_COOKIE = "google_drive_redirect_uri";

async function consumeGoogleDriveOAuthState() {
  const store = await cookies();
  const savedState = store.get(GOOGLE_DRIVE_STATE_COOKIE)?.value ?? null;
  const redirectUri = store.get(GOOGLE_DRIVE_REDIRECT_COOKIE)?.value ?? null;

  store.set(GOOGLE_DRIVE_STATE_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/"
  });
  store.set(GOOGLE_DRIVE_REDIRECT_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/"
  });

  return { savedState, redirectUri };
}

function getAppUrl(request: Request) {
  return process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
}

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const { savedState, redirectUri } = await consumeGoogleDriveOAuthState();

    if (!code) {
      return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=missing_code`);
    }

    if (!savedState || !returnedState || savedState !== returnedState) {
      return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=invalid_state`);
    }

    const existingConnection = await GoogleDriveConnection.findOne({ userId });
    const tokenPayload = await exchangeGoogleCode(code, redirectUri ?? undefined);

    await GoogleDriveConnection.findOneAndUpdate(
      { userId },
      {
        userId,
        accessToken: tokenPayload.access_token,
        refreshToken: tokenPayload.refresh_token || existingConnection?.refreshToken || undefined,
        connectedAt: new Date(),
        expiresAt: tokenPayload.expires_in ? new Date(Date.now() + tokenPayload.expires_in * 1000) : null,
        tokenStatus: "healthy",
        lastValidatedAt: new Date(),
        lastErrorCode: null,
        lastErrorAt: null
      },
      { upsert: true, new: true }
    );

    const refreshedConnection = await GoogleDriveConnection.findOne({ userId });
    if (!refreshedConnection?.refreshToken) {
      return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=google_refresh_token_missing`);
    }

    await logAction({
      userId,
      type: "auth",
      level: "success",
      message: "Google Drive connected successfully"
    }).catch(() => null);

    return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?success=1`);
  } catch (error) {
    try {
      const userId = await requireAuth();
      await GoogleDriveConnection.findOneAndUpdate(
        { userId },
        {
          tokenStatus: "warning",
          lastErrorCode: "google_oauth_failed",
          lastErrorAt: new Date()
        }
      ).catch(() => null);
      await logAction({
        userId,
        type: "error",
        level: "error",
        message: "Google Drive connection failed",
        metadata: { reason: error instanceof Error ? error.message : "unknown" }
      }).catch(() => null);
    } catch {}
    return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=oauth_failed`);
  }
}
