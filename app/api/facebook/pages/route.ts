import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { ensureValidFacebookConnection } from "@/lib/services/integration-auth";

type LeanFacebookConnection = {
  pages?: Array<{
    pageId: string;
    name: string;
    category?: string;
    pageAccessToken: string;
  }>;
  tokenStatus?: string;
};

export async function GET() {
  try {
    const userId = await requireAuth();
    const connection = (await ensureValidFacebookConnection(userId)) as LeanFacebookConnection | null;
    return jsonOk({ pages: connection?.pages ?? [], tokenStatus: connection?.tokenStatus ?? "unknown" });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to load Facebook pages right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
