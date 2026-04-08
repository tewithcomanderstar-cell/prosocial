import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getGoogleOAuthUrl } from "@/lib/services/google-drive";

export async function GET() {
  try {
    await requireAuth();
    return jsonOk({ url: getGoogleOAuthUrl() });
  } catch {
    return jsonError("Please login before connecting Google Drive", 401);
  }
}
