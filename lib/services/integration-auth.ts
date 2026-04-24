import { RouteError } from "@/lib/api";
import { createNotification, logAction } from "@/lib/services/logging";
import { fetchWithRetry } from "@/lib/services/http";
import { connectDb } from "@/lib/db";
import { FacebookConnection } from "@/models/FacebookConnection";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";

const FACEBOOK_TOKEN_VALIDATION_CACHE_MS = 15 * 60 * 1000;

export class IntegrationConnectionError extends RouteError {
  constructor(
    message: string,
    public readonly code:
      | "provider_not_connected"
      | "credential_invalid"
      | "reconnect_required"
      | "destination_disconnected"
      | "provider_unavailable",
    status = 400
  ) {
    super(message, status, code);
    this.name = "IntegrationConnectionError";
  }
}

async function markProviderStatus(
  userId: string,
  provider: "facebook" | "google-drive",
  status: "healthy" | "warning" | "expired",
  metadata: Record<string, unknown> = {}
) {
  const Model = provider === "facebook" ? FacebookConnection : GoogleDriveConnection;
  await Model.findOneAndUpdate(
    { userId },
    { tokenStatus: status, lastValidatedAt: new Date() },
    { new: true }
  );

  if (status !== "healthy") {
    await logAction({
      userId,
      type: "token",
      level: status === "expired" ? "error" : "warn",
      message: `${provider} token requires attention`,
      metadata
    });

    await createNotification({
      userId,
      type: "token",
      severity: status === "expired" ? "error" : "warn",
      title: `${provider} token ${status}`,
      message:
        status === "expired"
          ? `Reconnect ${provider} to resume automation.`
          : `Review ${provider} token soon to avoid interruptions.`,
      metadata
    });
  }
}

export async function ensureValidFacebookConnection(userId: string) {
  await connectDb();
  const connection = await FacebookConnection.findOne({ userId });

  if (!connection) {
    throw new IntegrationConnectionError("Facebook is not connected.", "provider_not_connected", 404);
  }

  const lastValidatedAtMs = connection.lastValidatedAt ? new Date(connection.lastValidatedAt).getTime() : null;
  const hasFreshValidation =
    connection.tokenStatus === "healthy" &&
    lastValidatedAtMs !== null &&
    Date.now() - lastValidatedAtMs < FACEBOOK_TOKEN_VALIDATION_CACHE_MS;

  if (hasFreshValidation) {
    return connection;
  }

  let response: Response;

  try {
    response = await fetchWithRetry(
      `https://graph.facebook.com/me?fields=id&access_token=${encodeURIComponent(connection.accessToken)}`,
      {
        cache: "no-store"
      }
    );
  } catch {
    throw new IntegrationConnectionError(
      "Unable to verify Facebook right now. Please try again shortly.",
      "provider_unavailable",
      503
    );
  }

  if (!response.ok) {
    await markProviderStatus(userId, "facebook", "expired", { source: "facebook-validate" });
    throw new IntegrationConnectionError(
      "Facebook token expired. Please reconnect your account.",
      "reconnect_required",
      401
    );
  }

  connection.tokenStatus = "healthy";
  connection.lastValidatedAt = new Date();
  await connection.save();
  return connection;
}

export async function getStoredFacebookConnection(userId: string) {
  await connectDb();
  const connection = await FacebookConnection.findOne({ userId });

  if (!connection) {
    throw new IntegrationConnectionError("Facebook is not connected.", "provider_not_connected", 404);
  }

  if (!connection.pages?.length) {
    throw new IntegrationConnectionError("No Facebook pages connected.", "destination_disconnected", 409);
  }

  return connection;
}

async function refreshGoogleDriveToken(userId: string, refreshToken: string) {
  const response = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    await markProviderStatus(userId, "google-drive", "expired", { source: "google-refresh", payload });
    throw new IntegrationConnectionError(
      "Google Drive token refresh failed. Please reconnect your account.",
      "reconnect_required",
      401
    );
  }

  const connection = await GoogleDriveConnection.findOneAndUpdate(
    { userId },
    {
      accessToken: payload.access_token,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000) : null,
      tokenStatus: "healthy",
      lastValidatedAt: new Date()
    },
    { new: true }
  );

  return connection;
}

export async function ensureValidGoogleDriveConnection(userId: string) {
  await connectDb();
  const connection = await GoogleDriveConnection.findOne({ userId });

  if (!connection) {
    throw new IntegrationConnectionError("Google Drive is not connected.", "provider_not_connected", 404);
  }

  const expiresAtMs = connection.expiresAt ? new Date(connection.expiresAt).getTime() : null;
  const needsRefresh = Boolean(expiresAtMs && expiresAtMs - Date.now() <= 5 * 60 * 1000);

  if (needsRefresh) {
    if (!connection.refreshToken) {
      await markProviderStatus(userId, "google-drive", "expired", { source: "google-missing-refresh-token" });
      throw new IntegrationConnectionError(
        "Google Drive token expired. Please reconnect your account.",
        "reconnect_required",
        401
      );
    }

    let refreshed;
    try {
      refreshed = await refreshGoogleDriveToken(userId, connection.refreshToken);
    } catch (error) {
      if (error instanceof IntegrationConnectionError) {
        throw error;
      }

      throw new IntegrationConnectionError(
        "Unable to verify Google Drive right now. Please try again shortly.",
        "provider_unavailable",
        503
      );
    }

    if (!refreshed) {
      throw new IntegrationConnectionError(
        "Google Drive token refresh failed. Please reconnect your account.",
        "reconnect_required",
        401
      );
    }

    return refreshed;
  }

  connection.tokenStatus = "healthy";
  connection.lastValidatedAt = new Date();
  await connection.save();
  return connection;
}
