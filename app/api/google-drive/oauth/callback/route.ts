import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { Types } from "mongoose";
import { requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { exchangeGoogleCode, GoogleDriveServiceError } from "@/lib/services/google-drive";
import { logAction } from "@/lib/services/logging";
import { resolveCurrentWorkspaceOrCreate } from "@/lib/services/workspace";

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

function mapGoogleCallbackError(error: unknown) {
  if (error instanceof GoogleDriveServiceError) {
    return error.code;
  }

  return "google_token_exchange_failed";
}

async function saveGoogleDriveCredential(input: {
  userId: string;
  workspaceId?: unknown;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
}) {
  const now = new Date();
  const expiresAt = input.expiresIn ? new Date(Date.now() + input.expiresIn * 1000) : null;
  const setPayload: Record<string, unknown> = {
    userId: input.userId,
    accessToken: input.accessToken,
    connectedAt: now,
    expiresAt,
    tokenStatus: "healthy",
    lastValidatedAt: now,
    lastErrorCode: null,
    lastErrorAt: null
  };

  if (input.workspaceId) {
    setPayload.workspaceId = input.workspaceId;
  }

  if (input.refreshToken) {
    setPayload.refreshToken = input.refreshToken;
  }

  try {
    return await GoogleDriveConnection.findOneAndUpdate(
      { userId: input.userId },
      { $set: setPayload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (primaryError) {
    const castUserId = Types.ObjectId.isValid(input.userId) ? new Types.ObjectId(input.userId) : input.userId;
    await GoogleDriveConnection.collection.updateOne(
      { userId: castUserId },
      {
        $set: {
          ...setPayload,
          userId: castUserId
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );

    await logAction({
      userId: input.userId,
      type: "auth",
      level: "warn",
      message: "Google Drive credential saved through raw fallback",
      metadata: {
        errorName: primaryError instanceof Error ? primaryError.name : "unknown",
        errorMessage: primaryError instanceof Error ? primaryError.message : "unknown"
      }
    }).catch(() => null);

    return GoogleDriveConnection.findOne({ userId: input.userId });
  }
}

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const workspace = await resolveCurrentWorkspaceOrCreate(userId).catch(() => null);
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const { savedState, redirectUri } = await consumeGoogleDriveOAuthState();

    if (!code) {
      return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=google_oauth_cancelled`);
    }

    if (!savedState || !returnedState || savedState !== returnedState) {
      return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=google_state_mismatch`);
    }

    const existingConnection = await GoogleDriveConnection.findOne({ userId });
    const tokenPayload = await exchangeGoogleCode(code, redirectUri ?? undefined);

    try {
      await saveGoogleDriveCredential({
        userId,
        workspaceId: workspace?._id,
        accessToken: tokenPayload.access_token,
        refreshToken: tokenPayload.refresh_token || existingConnection?.refreshToken || null,
        expiresIn: tokenPayload.expires_in ?? null
      });
    } catch (saveError) {
      await GoogleDriveConnection.findOneAndUpdate(
        { userId },
        {
          tokenStatus: "warning",
          lastErrorCode: "google_credential_save_failed",
          lastErrorAt: new Date()
        }
      ).catch(() => null);
      await logAction({
        userId,
        type: "error",
        level: "error",
        message: "Google Drive credential save failed after fallback",
        metadata: {
          errorName: saveError instanceof Error ? saveError.name : "unknown",
          errorMessage: saveError instanceof Error ? saveError.message : "unknown"
        }
      }).catch(() => null);
      return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=google_credential_save_failed`);
    }

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
    const errorCode = mapGoogleCallbackError(error);
    try {
      const userId = await requireAuth();
      await GoogleDriveConnection.findOneAndUpdate(
        { userId },
        {
          tokenStatus: "warning",
          lastErrorCode: errorCode,
          lastErrorAt: new Date()
        }
      ).catch(() => null);
      await logAction({
        userId,
        type: "error",
        level: "error",
        message: "Google Drive connection failed",
        metadata: { errorCode, reason: error instanceof Error ? error.message : "unknown" }
      }).catch(() => null);
    } catch {}
    return NextResponse.redirect(`${getAppUrl(request)}/connections/google-drive?error=${errorCode}`);
  }
}
