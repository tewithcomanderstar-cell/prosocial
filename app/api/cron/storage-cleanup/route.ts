import { jsonError, jsonOk, normalizeRouteError } from "@/lib/api";
import { cleanupAutoPostBlobs } from "@/lib/services/blob-storage";
import { runStorageCleanup } from "@/lib/services/storage-cleanup";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return jsonError("Unauthorized", 401, "unauthorized");
  }

  try {
    const result = await runStorageCleanup({ reason: "cron" });
    const blobCleanup = process.env.BLOB_READ_WRITE_TOKEN
      ? await cleanupAutoPostBlobs({ reason: "cron" })
      : {
          ok: false,
          enabled: false,
          reason: "missing_blob_token",
          deletedTotal: 0
        };
    return jsonOk({ cleanup: result, blobCleanup }, "Storage cleanup processed");
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to process storage cleanup");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
