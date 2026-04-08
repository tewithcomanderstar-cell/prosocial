import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { FacebookConnection } from "@/models/FacebookConnection";

type LeanFacebookConnection = {
  pages?: Array<{
    pageId: string;
    name: string;
    category?: string;
    pageAccessToken: string;
  }>;
};

export async function GET() {
  try {
    const userId = await requireAuth();
    const connection = (await FacebookConnection.findOne({ userId }).lean()) as LeanFacebookConnection | null;
    return jsonOk({ pages: connection?.pages ?? [] });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
