import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { fetchDriveFolders, fetchImagesFromFolder } from "@/lib/services/google-drive";

type LeanGoogleConnection = {
  accessToken: string;
};

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const connection = (await GoogleDriveConnection.findOne({ userId }).lean()) as LeanGoogleConnection | null;

    if (!connection) {
      return jsonOk({ images: [] }, "No Google Drive connection yet");
    }

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
    return jsonOk({ images: payload.files });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to fetch images", 400);
  }
}
