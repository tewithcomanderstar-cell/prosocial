import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { inspectTokenStatus } from "@/lib/services/tokens";

export async function GET() {
  try {
    const userId = await requireAuth();
    const tokens = await inspectTokenStatus(userId);
    return jsonOk({ tokens });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
