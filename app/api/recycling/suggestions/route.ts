import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getRecyclingSuggestions } from "@/lib/services/recycling";

export async function GET() {
  try {
    const userId = await requireAuth();
    const data = await getRecyclingSuggestions(userId);
    return jsonOk(data);
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
