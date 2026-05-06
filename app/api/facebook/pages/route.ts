import { NextResponse } from "next/server";
import { jsonError, normalizeRouteError, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { safeLogAction } from "@/lib/services/logging";
import { resolveCurrentWorkspaceOrCreate } from "@/lib/services/workspace";
import { getResolvedFacebookPagesState } from "@/lib/services/facebook-pages-state";
import { FacebookConnection } from "@/models/FacebookConnection";

type CachedFacebookConnection = {
  tokenStatus?: string | null;
  pages?: Array<{
    pageId: string;
    name: string;
    category?: string | null;
    profilePictureUrl?: string | null;
    profilePictureFetchedAt?: Date | string | null;
    pageAccessToken?: string | null;
  }>;
};

export async function GET() {
  let userId: string | null = null;
  let workspaceId: string | null = null;

  try {
    await connectDb();
    userId = await requireAuth();
    const workspace = await resolveCurrentWorkspaceOrCreate(userId);
    workspaceId = String(workspace._id);
    const payload = await getResolvedFacebookPagesState(userId);

    await safeLogAction({
      userId,
      type: "auth",
      level: payload.fallbackToCachedPages ? "warn" : "info",
      message: "Resolved Facebook pages list",
      metadata: {
        userId,
        workspaceId,
        workspaceIdPresent: Boolean(workspace?._id),
        responseShape: payload.responseShape,
        connectedPageCount: payload.storedConnectedPageCount,
        pagesCount: payload.count,
        parsedPagesCount: payload.pages.length,
        responseKeys: ["ok", "message", "data"],
        fallbackToCachedPages: payload.fallbackToCachedPages,
        warning: payload.warning,
        errorCode: payload.warningCode,
        queryFilter: { userId, workspaceId }
      }
    });

    return NextResponse.json({
      ok: true,
      message: undefined,
      data: payload,
      pages: payload.pages,
      count: payload.count,
      warning: payload.warning,
      warningCode: payload.warningCode,
      source: payload.source,
      responseShape: payload.responseShape
    });
  } catch (error) {
    if (userId) {
      const cachedConnection = (await FacebookConnection.findOne({ userId }).lean().catch(() => null)) as
        | CachedFacebookConnection
        | null;
      const cachedPages = (cachedConnection?.pages ?? []).map((page: any) => ({
        pageId: page.pageId,
        name: page.name,
        category: page.category,
        profilePictureUrl: page.profilePictureUrl ?? null,
        profilePictureFetchedAt: page.profilePictureFetchedAt ?? null
      }));

      if (cachedPages.length > 0) {
        const normalized = normalizeRouteError(error, "Unable to validate Facebook pages right now.");
        await safeLogAction({
          userId,
          type: "auth",
          level: "warn",
          message: "Returned cached Facebook pages after list route warning",
          metadata: {
            userId,
            workspaceId,
            responseShape: "data.pages",
            pagesCount: cachedPages.length,
            parsedPagesCount: cachedPages.length,
            fallbackToCachedPages: true,
            errorCode: normalized.code
          }
        });

        const fallbackPayload = {
          pages: cachedPages,
          count: cachedPages.length,
          tokenStatus: cachedConnection?.tokenStatus ?? "warning",
          warning: normalized.code,
          warningCode: normalized.code,
          source: "database_cache",
          fallbackToCachedPages: true,
          storedConnectedPageCount: cachedPages.length,
          storedValidPageTokenCount: (cachedConnection?.pages ?? []).filter((page: any) => Boolean(page.pageAccessToken)).length,
          lastPagesErrorCode: normalized.code,
          responseShape: "data.pages"
        };

        return NextResponse.json({
          ok: true,
          message: undefined,
          data: fallbackPayload,
          pages: fallbackPayload.pages,
          count: fallbackPayload.count,
          warning: fallbackPayload.warning,
          warningCode: fallbackPayload.warningCode,
          source: fallbackPayload.source,
          responseShape: fallbackPayload.responseShape
        });
      }
    }

    const normalized = normalizeRouteError(error, "Unable to load Facebook pages right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
