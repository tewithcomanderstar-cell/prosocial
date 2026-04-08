import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getSmartRecommendations } from "@/lib/services/recommendations";

export async function GET() {
  try {
    const userId = await requireAuth();
    const data = await getSmartRecommendations(userId);
    return jsonOk(data);
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
