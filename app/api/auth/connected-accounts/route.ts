import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { FacebookConnection } from "@/models/FacebookConnection";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { User } from "@/models/User";

function buildBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export async function GET() {
  try {
    await connectDb();
    const userId = await requireAuth();

    const [user, facebookConnection, googleDriveConnection] = await Promise.all([
      User.findById(userId),
      FacebookConnection.findOne({ userId }),
      GoogleDriveConnection.findOne({ userId })
    ]);

    if (!user) {
      return jsonError("User not found", 404);
    }

    const baseUrl = buildBaseUrl();

    return jsonOk({
      accounts: [
        {
          id: "facebook-login",
          name: "Facebook Login",
          kind: "social",
          provider: "facebook",
          connected: user.provider === "facebook" && Boolean(user.providerId),
          detail: user.provider === "facebook" ? user.email : null,
          connectedAt: user.provider === "facebook" ? user.updatedAt : null,
          reconnectUrl: `${baseUrl}/api/auth/facebook/start`
        },
        {
          id: "google-login",
          name: "Google Login",
          kind: "social",
          provider: "google",
          connected: user.provider === "google" && Boolean(user.providerId),
          detail: user.provider === "google" ? user.email : null,
          connectedAt: user.provider === "google" ? user.updatedAt : null,
          reconnectUrl: `${baseUrl}/api/auth/google/start`
        },
        {
          id: "facebook-pages",
          name: "Facebook Pages",
          kind: "integration",
          provider: "facebook",
          connected: Boolean(facebookConnection),
          detail: facebookConnection ? `${facebookConnection.pages?.length ?? 0} pages` : null,
          connectedAt: facebookConnection?.connectedAt ?? null,
          reconnectUrl: `${baseUrl}/api/facebook/oauth/url`,
          tokenStatus: facebookConnection?.tokenStatus ?? "unknown"
        },
        {
          id: "google-drive",
          name: "Google Drive",
          kind: "integration",
          provider: "google",
          connected: Boolean(googleDriveConnection),
          detail: googleDriveConnection?.tokenStatus ?? null,
          connectedAt: googleDriveConnection?.connectedAt ?? null,
          reconnectUrl: `${baseUrl}/api/google-drive/oauth/url`,
          tokenStatus: googleDriveConnection?.tokenStatus ?? "unknown"
        }
      ]
    });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
