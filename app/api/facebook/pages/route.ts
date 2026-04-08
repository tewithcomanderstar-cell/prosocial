import { jsonError, jsonOk, requireAuth } from "@/lib/api";
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
    return jsonError(error instanceof Error ? error.message : "Unauthorized", 401);
  }
}
