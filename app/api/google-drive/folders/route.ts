import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { fetchDriveFolders, GoogleDriveServiceError } from "@/lib/services/google-drive";
import { ensureValidGoogleDriveConnection, refreshGoogleDriveToken } from "@/lib/services/integration-auth";
import { resolveCurrentWorkspaceOrCreate } from "@/lib/services/workspace";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";

async function recordDriveListWarning(userId: string, error: GoogleDriveServiceError) {
  await GoogleDriveConnection.findOneAndUpdate(
    { userId },
    {
      tokenStatus:
        error.code === "google_drive_scope_missing" || error.code === "google_drive_fetch_failed"
          ? "warning"
          : "expired",
      lastErrorCode: error.code,
      lastErrorAt: new Date()
    }
  ).catch(() => null);
}

export async function GET() {
  try {
    const userId = await requireAuth();
    await resolveCurrentWorkspaceOrCreate(userId).catch(() => null);
    const connection = await ensureValidGoogleDriveConnection(userId);
    let payload;
    try {
      payload = await fetchDriveFolders(connection.accessToken, "root");
    } catch (driveError) {
      if (
        driveError instanceof GoogleDriveServiceError &&
        driveError.code === "google_drive_token_invalid" &&
        connection.refreshToken
      ) {
        const refreshed = await refreshGoogleDriveToken(userId, connection.refreshToken);
        if (!refreshed?.accessToken) {
          throw driveError;
        }
        try {
          payload = await fetchDriveFolders(refreshed.accessToken, "root");
        } catch (retryError) {
          if (
            retryError instanceof GoogleDriveServiceError &&
            retryError.code === "google_drive_fetch_failed"
          ) {
            await recordDriveListWarning(userId, retryError);
            return jsonOk(
              {
                folders: [{ id: "root", name: "My Drive" }],
                tokenStatus: "warning",
                warning: retryError.code
              },
              "Google Drive is connected, but folder listing is temporarily unavailable."
            );
          }
          throw retryError;
        }
      } else {
        if (driveError instanceof GoogleDriveServiceError) {
          await recordDriveListWarning(userId, driveError);

          if (driveError.code === "google_drive_fetch_failed") {
            return jsonOk(
              {
                folders: [{ id: "root", name: "My Drive" }],
                tokenStatus: "warning",
                warning: driveError.code
              },
              "Google Drive is connected, but folder listing is temporarily unavailable."
            );
          }
        }
        throw driveError;
      }
    }
    const folders = [{ id: "root", name: "My Drive" }, ...payload.files];
    return jsonOk({ folders, tokenStatus: connection.tokenStatus ?? "healthy" });
  } catch (error) {
    const normalized = normalizeRouteError(
      error,
      "Unable to verify Google Drive right now. Please try again shortly."
    );
    const code =
      error instanceof GoogleDriveServiceError
        ? error.code
        : normalized.code === "reconnect_required"
          ? "google_reconnect_required"
        : normalized.code === "provider_not_connected"
          ? "google_drive_not_connected"
        : normalized.code === "google_refresh_token_missing"
          ? "google_refresh_token_missing"
            : normalized.code === "internal_error"
              ? "google_drive_fetch_failed"
              : normalized.code;
    return jsonError(normalized.message, normalized.status, code);
  }
}
