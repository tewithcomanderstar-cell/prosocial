import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getAnalyticsOverview } from "@/lib/services/analytics";

export async function GET() {
  try {
    const userId = await requireAuth();
    const overview = await getAnalyticsOverview(userId);
    return jsonOk(overview);
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
