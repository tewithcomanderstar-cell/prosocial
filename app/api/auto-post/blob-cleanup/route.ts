import { z } from "zod";
import { jsonError, jsonOk, normalizeRouteError, parseBody } from "@/lib/api";
import { cleanupAutoPostBlobs } from "@/lib/services/blob-storage";
import { handleRoleError, requireRole } from "@/lib/services/permissions";

const cleanupSchema = z.object({
  aggressive: z.boolean().optional(),
  reason: z.string().max(120).optional()
});

export async function POST(request: Request) {
  try {
    await requireRole(["admin", "editor"]);
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const payload = parseBody(cleanupSchema, body);
    const result = await cleanupAutoPostBlobs({
      aggressive: payload.aggressive,
      reason: payload.reason ?? "manual_button"
    });

    return jsonOk({ cleanup: result }, "Blob cleanup completed");
  } catch (error) {
    if (error instanceof Error && (error.message === "FORBIDDEN" || error.message === "UNAUTHORIZED")) {
      return handleRoleError(error);
    }

    const normalized = normalizeRouteError(error, "Unable to run blob cleanup");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
