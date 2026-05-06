import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { safeLogAction } from "@/lib/services/logging";
import { resolveCurrentWorkspaceOrCreate } from "@/lib/services/workspace";
import { getResolvedFacebookPagesState } from "@/lib/services/facebook-pages-state";

export async function GET() {
  try {
    await connectDb();
    const userId = await requireAuth();
    const workspace = await resolveCurrentWorkspaceOrCreate(userId);
    const payload = await getResolvedFacebookPagesState(userId);

    await safeLogAction({
      userId,
      type: "auth",
      level: payload.fallbackToCachedPages ? "warn" : "info",
      message: "Resolved Facebook pages list",
      metadata: {
        userId,
        workspaceId: String(workspace._id),
        workspaceIdPresent: Boolean(workspace?._id),
        responseShape: payload.responseShape,
        connectedPageCount: payload.storedConnectedPageCount,
        pagesCount: payload.count,
        parsedPagesCount: payload.pages.length,
        responseKeys: ["ok", "message", "data"],
        fallbackToCachedPages: payload.fallbackToCachedPages,
        warning: payload.warning,
        errorCode: payload.warningCode,
        queryFilter: { userId, workspaceId: String(workspace._id) }
      }
    });

    return jsonOk(payload);
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to load Facebook pages right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
