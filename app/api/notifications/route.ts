import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { Notification } from "@/models/Notification";

export async function GET() {
  try {
    const userId = await requireAuth();
    const notifications = await Notification.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
    return jsonOk({ notifications });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
