import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { fetchDriveFolders, fetchImagesFromFolder, GoogleDriveServiceError } from "@/lib/services/google-drive";
import { ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import { resolveCurrentWorkspaceOrCreate } from "@/lib/services/workspace";

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    await resolveCurrentWorkspaceOrCreate(userId);
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

    const payload = await fetchImagesFromFolder(connection.accessToken, folderId);
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
            : normalized.code;
    return jsonError(normalized.message, normalized.status, code);
  }
}
