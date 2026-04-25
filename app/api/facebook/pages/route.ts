import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { ensureValidFacebookConnection } from "@/lib/services/integration-auth";

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
    const userId = await requireAuth();
    const connection = (await ensureValidFacebookConnection(userId)) as LeanFacebookConnection | null;
    return jsonOk({
      pages: (connection?.pages ?? []).map((page) => ({
        pageId: page.pageId,
        name: page.name,
        category: page.category,
        profilePictureUrl: page.profilePictureUrl ?? null,
        profilePictureFetchedAt: page.profilePictureFetchedAt ?? null
      })),
      tokenStatus: connection?.tokenStatus ?? "unknown"
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to load Facebook pages right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
