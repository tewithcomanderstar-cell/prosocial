import { FacebookConnection } from "@/models/FacebookConnection";
import { ensureValidFacebookConnection, IntegrationConnectionError } from "@/lib/services/integration-auth";

type LeanFacebookConnection = {
  workspaceId?: string | null;
  pages?: Array<{
    pageId: string;
    name: string;
    category?: string;
    profilePictureUrl?: string | null;
    profilePictureFetchedAt?: Date | string | null;
    pageAccessToken?: string;
  }>;
  tokenStatus?: string;
  lastErrorCode?: string | null;
};

export async function getResolvedFacebookPagesState(userId: string) {
  const storedConnection = (await FacebookConnection.findOne({ userId }).lean()) as LeanFacebookConnection | null;

  if (!storedConnection) {
    throw new IntegrationConnectionError("Facebook is not connected.", "provider_not_connected", 404);
  }

  let connection: LeanFacebookConnection | null = storedConnection;
  let fallbackToCachedPages = false;
  let warningCode: string | null = null;
  let source: "database_cache" | "validated_connection" = "validated_connection";

  try {
    connection = (await ensureValidFacebookConnection(userId).then((result) => result?.toObject?.() ?? result)) as
      | LeanFacebookConnection
      | null;
  } catch (error) {
    if (
      error instanceof IntegrationConnectionError &&
      error.code !== "provider_not_connected" &&
      (storedConnection.pages?.length ?? 0) > 0
    ) {
      connection = storedConnection;
      fallbackToCachedPages = true;
      warningCode = error.code;
      source = "database_cache";
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

  return {
    pages,
    count: pages.length,
    tokenStatus: connection?.tokenStatus ?? "unknown",
    warning: warningCode,
    warningCode,
    source,
    fallbackToCachedPages,
    storedConnectedPageCount: storedConnection.pages?.length ?? 0,
    storedValidPageTokenCount: (storedConnection.pages ?? []).filter((page) => Boolean(page.pageAccessToken)).length,
    lastPagesErrorCode: warningCode ?? connection?.lastErrorCode ?? storedConnection.lastErrorCode ?? null,
    responseShape: "data.pages" as const
  };
}
