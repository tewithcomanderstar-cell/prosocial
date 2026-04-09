import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { fetchDriveFolders } from "@/lib/services/google-drive";
import { ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";

export async function GET() {
  try {
    const userId = await requireAuth();
    const connection = await ensureValidGoogleDriveConnection(userId);
    const payload = await fetchDriveFolders(connection.accessToken, "root");
    const folders = [
      { id: "root", name: "My Drive" },
      ...payload.files
    ];
    return jsonOk({ folders, tokenStatus: connection.tokenStatus ?? "healthy" });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to fetch folders", 400);
  }
}
