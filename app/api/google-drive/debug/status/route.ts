import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { getOAuthConfigDebug } from "@/lib/services/oauth-debug";

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const connection = await GoogleDriveConnection.findOne({ userId });
    const oauthDebug = getOAuthConfigDebug(request);
    const connected = Boolean(connection?.accessToken || connection?.refreshToken);
    const hasRefreshToken = Boolean(connection?.refreshToken);
    const credentialStatus = !connection
      ? "disconnected"
      : hasRefreshToken
        ? connection.tokenStatus ?? "healthy"
        : "needs_reconnect";
    const canRefreshToken = Boolean(
      hasRefreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    );
    const failingEndpoint =
      connection?.lastErrorCode?.startsWith("google_token") || connection?.lastErrorCode?.includes("redirect")
        ? "oauth_callback"
        : connection?.lastErrorCode?.includes("fetch")
          ? "drive_list"
          : connection?.lastErrorCode?.includes("refresh")
            ? "token_refresh"
            : null;

    return jsonOk({
      connected,
      hasGoogleAccount: connected,
      hasRefreshToken,
      credentialStatus,
      tokenExpiresAt: connection?.expiresAt ?? null,
      canRefreshToken,
      lastVerifiedAt: connection?.lastValidatedAt ?? null,
      lastErrorCode: connection?.lastErrorCode ?? null,
      failingEndpoint,
      googleRedirectUri: oauthDebug.googleDriveRedirectUri,
      hasGoogleClientId: oauthDebug.hasGoogleClientId,
      hasGoogleClientSecret: oauthDebug.hasGoogleClientSecret
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to inspect Google Drive status right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
