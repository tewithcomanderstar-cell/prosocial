import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { FacebookConnection } from "@/models/FacebookConnection";
import { ensureValidFacebookConnection, IntegrationConnectionError } from "@/lib/services/integration-auth";
import { safeLogAction } from "@/lib/services/logging";

type LeanFacebookConnection = {
  pages?: Array<{
    pageId: string;
    name: string;
    category?: string;
    profilePictureUrl?: string | null;
    profilePictureFetchedAt?: Date | string | null;
  }>;
  tokenStatus?: string;
};

export async function GET() {
  try {
    await connectDb();
    const userId = await requireAuth();
    const storedConnection = (await FacebookConnection.findOne({ userId })) as LeanFacebookConnection | null;

    if (!storedConnection) {
      throw new IntegrationConnectionError("Facebook is not connected.", "provider_not_connected", 404);
    }

    let connection: LeanFacebookConnection | null = storedConnection;
    let fallbackToCachedPages = false;
    let warningCode: string | null = null;

    try {
      connection = (await ensureValidFacebookConnection(userId)) as LeanFacebookConnection | null;
    } catch (error) {
      if (
        error instanceof IntegrationConnectionError &&
        error.code !== "provider_not_connected" &&
        (storedConnection.pages?.length ?? 0) > 0
      ) {
        connection = storedConnection;
        fallbackToCachedPages = true;
        warningCode = error.code;
      } else {
        throw error;
      }
    }

    const pages =
      (connection?.pages ?? []).map((page) => ({
        pageId: page.pageId,
        name: page.name,
        category: page.category,
        profilePictureUrl: page.profilePictureUrl ?? null,
        profilePictureFetchedAt: page.profilePictureFetchedAt ?? null
      })) ?? [];

    await safeLogAction({
      userId,
      type: "auth",
      level: fallbackToCachedPages ? "warn" : "info",
      message: "Resolved Facebook pages list",
      metadata: {
        userId,
        workspaceIdPresent: false,
        facebookAccountPresent: true,
        connectedPageCount: storedConnection.pages?.length ?? 0,
        pagesReturnedCount: pages.length,
        fallbackToCachedPages,
        warningCode,
        queryFilter: { userId }
      }
    });

    return jsonOk({
      pages,
      tokenStatus: connection?.tokenStatus ?? "unknown",
      warningCode,
      fallbackToCachedPages
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to load Facebook pages right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
