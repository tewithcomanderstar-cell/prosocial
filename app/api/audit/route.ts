import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { AuditEntry } from "@/models/AuditEntry";

export async function GET() {
  try {
    const userId = await requireAuth();
    const entries = await AuditEntry.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return jsonOk({ entries });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
