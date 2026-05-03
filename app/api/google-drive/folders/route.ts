import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { fetchDriveFolders, GoogleDriveServiceError } from "@/lib/services/google-drive";
import { ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";

export async function GET() {
  try {
    const userId = await requireAuth();
    const connection = await ensureValidGoogleDriveConnection(userId);
    const payload = await fetchDriveFolders(connection.accessToken, "root");
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
            : normalized.code;
    return jsonError(normalized.message, normalized.status, code);
  }
}
