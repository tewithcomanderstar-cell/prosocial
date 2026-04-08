import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getLearningInsights } from "@/lib/services/learning";

export async function GET() {
  try {
    const userId = await requireAuth();
    const data = await getLearningInsights(userId);
    return jsonOk(data);
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
