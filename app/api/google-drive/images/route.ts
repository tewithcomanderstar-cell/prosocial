import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { fetchDriveFolders, fetchImagesFromFolder } from "@/lib/services/google-drive";
import { ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
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
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
