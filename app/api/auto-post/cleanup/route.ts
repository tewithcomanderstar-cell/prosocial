import { z } from "zod";
import { jsonError, jsonOk, normalizeRouteError, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { runStorageCleanup } from "@/lib/services/storage-cleanup";

const cleanupSchema = z.object({
  aggressive: z.boolean().optional(),
  reason: z.string().max(120).optional()
});

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const payload = parseBody(cleanupSchema, body);
    const result = await runStorageCleanup({
      userId,
      aggressive: payload.aggressive,
      reason: payload.reason ?? "manual_button"
    });

    return jsonOk({ cleanup: result }, "Storage cleanup completed");
  } catch (error) {
    if (error instanceof Error && (error.message === "FORBIDDEN" || error.message === "UNAUTHORIZED")) {
      return handleRoleError(error);
    }

    const normalized = normalizeRouteError(error, "Unable to run storage cleanup");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
