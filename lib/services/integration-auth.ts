import { createNotification, logAction } from "@/lib/services/logging";
import { fetchWithRetry } from "@/lib/services/http";
import { connectDb } from "@/lib/db";
import { FacebookConnection } from "@/models/FacebookConnection";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";

async function markProviderStatus(userId: string, provider: "facebook" | "google-drive", status: "healthy" | "warning" | "expired", metadata: Record<string, unknown> = {}) {
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
      message: status === "expired"
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
    throw new Error("Facebook is not connected");
  }

  const response = await fetchWithRetry(`https://graph.facebook.com/me?fields=id&access_token=${encodeURIComponent(connection.accessToken)}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    await markProviderStatus(userId, "facebook", "expired", { source: "facebook-validate" });
    throw new Error("Facebook token expired. Please reconnect your account.");
  }

  connection.tokenStatus = "healthy";
  connection.lastValidatedAt = new Date();
  await connection.save();
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
    throw new Error("Google Drive token refresh failed. Please reconnect your account.");
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
    throw new Error("Google Drive is not connected");
  }

  const expiresAtMs = connection.expiresAt ? new Date(connection.expiresAt).getTime() : null;
  const needsRefresh = Boolean(expiresAtMs && expiresAtMs - Date.now() <= 5 * 60 * 1000);

  if (needsRefresh) {
    if (!connection.refreshToken) {
      await markProviderStatus(userId, "google-drive", "expired", { source: "google-missing-refresh-token" });
      throw new Error("Google Drive token expired. Please reconnect your account.");
    }

    const refreshed = await refreshGoogleDriveToken(userId, connection.refreshToken);
    if (!refreshed) {
      throw new Error("Google Drive token refresh failed. Please reconnect your account.");
    }

    return refreshed;
  }

  connection.tokenStatus = "healthy";
  connection.lastValidatedAt = new Date();
  await connection.save();
  return connection;
}
