import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { fetchDriveFolders, fetchImagesFromFolder, GoogleDriveServiceError } from "@/lib/services/google-drive";
import { ensureValidGoogleDriveConnection, refreshGoogleDriveToken } from "@/lib/services/integration-auth";
import { resolveCurrentWorkspaceOrCreate } from "@/lib/services/workspace";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    await resolveCurrentWorkspaceOrCreate(userId).catch(() => null);
    const connection = await ensureValidGoogleDriveConnection(userId);

    const url = new URL(request.url);
    let folderId = url.searchParams.get("folderId");

    if (!folderId) {
      const folders = await fetchDriveFolders(connection.accessToken);
      folderId = folders.files[0]?.id;
    }

    if (!folderId) {
      return jsonOk({ images: [] }, "No image folder found");
    }

    let payload;
    try {
      payload = await fetchImagesFromFolder(connection.accessToken, folderId);
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
        payload = await fetchImagesFromFolder(refreshed.accessToken, folderId);
      } else {
        if (driveError instanceof GoogleDriveServiceError) {
          await GoogleDriveConnection.findOneAndUpdate(
            { userId },
            {
              tokenStatus:
                driveError.code === "google_drive_scope_missing" || driveError.code === "google_drive_fetch_failed"
                  ? "warning"
                  : "expired",
              lastErrorCode: driveError.code,
              lastErrorAt: new Date()
            }
          ).catch(() => null);
        }
        throw driveError;
      }
    }
    return jsonOk({ images: payload.files, tokenStatus: connection.tokenStatus ?? "healthy" });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to fetch Google Drive images right now.");
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
