import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";

export async function GET() {
  try {
    await connectDb();
    const userId = await requireAuth();
    const connection = await GoogleDriveConnection.findOne({ userId });

    return jsonOk({
      hasGoogleAccount: Boolean(connection),
      hasRefreshToken: Boolean(connection?.refreshToken),
      credentialStatus: connection?.tokenStatus ?? "not_connected",
      tokenExpiresAt: connection?.expiresAt ?? null,
      canRefreshToken: Boolean(
        connection?.refreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ),
      lastVerifiedAt: connection?.lastValidatedAt ?? null,
      lastErrorCode: connection?.lastErrorCode ?? null
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to inspect Google Drive status right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
