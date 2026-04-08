import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getTrendIdeas } from "@/lib/services/trends";

export async function GET() {
  try {
    const userId = await requireAuth();
    const data = await getTrendIdeas(userId);
    return jsonOk(data);
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
