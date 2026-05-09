import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { fetchDriveProbe, GoogleDriveServiceError, describeGoogleDriveError } from "@/lib/services/google-drive";
import { ensureValidGoogleDriveConnection, refreshGoogleDriveToken } from "@/lib/services/integration-auth";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";

export async function GET() {
  try {
    const userId = await requireAuth();
    const connection = await ensureValidGoogleDriveConnection(userId);
    let probe;

    try {
      probe = await fetchDriveProbe(connection.accessToken);
    } catch (error) {
      if (
        error instanceof GoogleDriveServiceError &&
        error.code === "google_drive_token_invalid" &&
        connection.refreshToken
      ) {
        const refreshed = await refreshGoogleDriveToken(userId, connection.refreshToken);
        if (!refreshed?.accessToken) {
          throw error;
        }
        probe = await fetchDriveProbe(refreshed.accessToken);
      } else {
        throw error;
      }
    }

    await GoogleDriveConnection.findOneAndUpdate(
      { userId },
      {
        tokenStatus: "healthy",
        lastValidatedAt: new Date(),
        lastErrorCode: null,
        lastErrorAt: null
      }
    ).catch(() => null);

    return jsonOk({
      connected: true,
      ...probe
    });
  } catch (error) {
    const driveError = describeGoogleDriveError(error);
    const normalized = normalizeRouteError(error, "Unable to probe Google Drive right now.");
    const code = driveError.code === "unknown_error" ? normalized.code : driveError.code;
    return jsonError(driveError.details || normalized.message, normalized.status, code);
  }
}
