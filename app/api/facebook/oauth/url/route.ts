import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { FacebookOAuthError, getFacebookOAuthUrl } from "@/lib/services/facebook";

export async function GET() {
  try {
    await requireAuth();
    return jsonOk({ url: getFacebookOAuthUrl() });
  } catch (error) {
    if (error instanceof FacebookOAuthError) {
      return jsonError(error.code, 400);
    }

    return jsonError("Please login before connecting Facebook", 401);
  }
}
