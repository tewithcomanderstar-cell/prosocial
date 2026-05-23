import { isUnauthorizedError, jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { getStorageStatus } from "@/lib/services/storage-cleanup";

export async function GET() {
  try {
    await requireAuth();
    const status = await getStorageStatus();
    return jsonOk({ storage: status });
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return jsonError("Unauthorized", 401, "unauthorized");
    }

    const normalized = normalizeRouteError(error, "Unable to load storage status");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
