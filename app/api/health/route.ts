import { isUnauthorizedError, jsonError, jsonOk, requireAuth } from "@/lib/api";
import { runHealthChecks } from "@/lib/services/monitoring";

export async function GET() {
  try {
    const userId = await requireAuth();
    const checks = await runHealthChecks(userId);
    return jsonOk({ checks });
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return jsonError("Unauthorized", 401);
    }

    return jsonError(error instanceof Error ? error.message : "Unable to load health checks", 500);
  }
}
