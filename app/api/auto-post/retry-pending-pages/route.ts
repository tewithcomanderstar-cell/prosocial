import { jsonError, jsonOk } from "@/lib/api";
import { retryPendingShopeePageJobs } from "@/lib/services/queue";
import { handleRoleError, requireRole } from "@/lib/services/permissions";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const body = await request.json().catch(() => ({}));
    const configId = typeof body?.configId === "string" && body.configId.trim() ? body.configId.trim() : undefined;
    const result = await retryPendingShopeePageJobs(userId, configId);

    if (result.requeued === 0) {
      return jsonOk(result, result.message ?? "No pending Shopee page jobs found");
    }

    return jsonOk(result, `Re-queued ${result.requeued} pending Shopee page task(s)`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("settings not found")) {
      return jsonError(error.message, 404);
    }
    return handleRoleError(error);
  }
}
