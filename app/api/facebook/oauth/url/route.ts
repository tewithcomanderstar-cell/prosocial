import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getFacebookOAuthUrl } from "@/lib/services/facebook";

export async function GET() {
  try {
    await requireAuth();
    return jsonOk({ url: getFacebookOAuthUrl() });
  } catch {
    return jsonError("Please login before connecting Facebook", 401);
  }
}
