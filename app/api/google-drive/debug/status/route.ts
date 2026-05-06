import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { getOAuthConfigDebug } from "@/lib/services/oauth-debug";
import { resolveCurrentWorkspaceOrCreate } from "@/lib/services/workspace";

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const workspace = await resolveCurrentWorkspaceOrCreate(userId).catch(() => null);
    const connection = await GoogleDriveConnection.findOne({ userId });
    const oauthDebug = getOAuthConfigDebug(request);
    const hasRefreshToken = Boolean(connection?.refreshToken);
    const hasUsableAccessToken = Boolean(connection?.accessToken);
    const connected = Boolean(connection && hasRefreshToken);
    const credentialStatus = !connection
      ? "disconnected"
      : !hasRefreshToken
        ? "needs_reconnect"
        : !hasUsableAccessToken
          ? "needs_reconnect"
          : connection.tokenStatus && connection.tokenStatus !== "unknown"
            ? connection.tokenStatus
            : "healthy";
    const canRefreshToken = Boolean(
      connected && hasRefreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
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
      hasGoogleAccount: Boolean(connection),
      hasRefreshToken,
      credentialStatus,
      tokenExpiresAt: connection?.expiresAt ?? null,
      canRefreshToken,
      lastVerifiedAt: connection?.lastValidatedAt ?? null,
      lastErrorCode: connection?.lastErrorCode ?? null,
      failingEndpoint,
      googleRedirectUri: oauthDebug.googleDriveRedirectUri,
      hasGoogleClientId: oauthDebug.hasGoogleClientId,
      hasGoogleClientSecret: oauthDebug.hasGoogleClientSecret,
      workspaceIdPresent: Boolean(workspace?._id),
      workspaceErrorCode: workspace ? null : "workspace_not_found"
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to inspect Google Drive status right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
