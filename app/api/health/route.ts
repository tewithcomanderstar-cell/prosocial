import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { runHealthChecks } from "@/lib/services/monitoring";

export async function GET() {
  try {
    const userId = await requireAuth();
    const checks = await runHealthChecks(userId);
    return jsonOk({ checks });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
