import { jsonError, jsonOk, normalizeRouteError } from "@/lib/api";
import { runStorageCleanup } from "@/lib/services/storage-cleanup";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return jsonError("Unauthorized", 401, "unauthorized");
  }

  try {
    const result = await runStorageCleanup({ reason: "cron" });
    return jsonOk({ cleanup: result }, "Storage cleanup processed");
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to process storage cleanup");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
