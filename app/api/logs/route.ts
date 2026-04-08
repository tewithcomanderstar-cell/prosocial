import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { ActionLog } from "@/models/ActionLog";

export async function GET() {
  try {
    const userId = await requireAuth();
    const logs = await ActionLog.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return jsonOk({ logs });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
