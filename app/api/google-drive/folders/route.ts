import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { fetchDriveFolders } from "@/lib/services/google-drive";

type LeanGoogleConnection = {
  accessToken: string;
};

export async function GET() {
  try {
    const userId = await requireAuth();
    const connection = (await GoogleDriveConnection.findOne({ userId }).lean()) as LeanGoogleConnection | null;

    if (!connection) {
      return jsonOk({ folders: [] }, "No Google Drive connection yet");
    }

    const payload = await fetchDriveFolders(connection.accessToken);
    return jsonOk({ folders: payload.files });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to fetch folders", 400);
  }
}
