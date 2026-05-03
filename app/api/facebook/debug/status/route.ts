import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { User } from "@/models/User";
import { FacebookConnection } from "@/models/FacebookConnection";
import { fetchWithRetry } from "@/lib/services/http";

const REQUIRED_PAGE_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement"
];

export async function GET() {
  try {
    await connectDb();
    const userId = await requireAuth();
    const [user, connection] = await Promise.all([
      User.findById(userId),
      FacebookConnection.findOne({ userId })
    ]);

    let missingScopeList = [...REQUIRED_PAGE_SCOPES];
    if (connection?.accessToken) {
      try {
        const url = new URL("https://graph.facebook.com/v21.0/me/permissions");
        url.searchParams.set("access_token", connection.accessToken);
        const response = await fetchWithRetry(url.toString(), { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as
          | { data?: Array<{ permission?: string; status?: string }> }
          | null;

        if (response.ok && payload?.data) {
          const granted = new Set(
            payload.data
              .filter((item) => item.status === "granted" && item.permission)
              .map((item) => String(item.permission))
          );
          missingScopeList = REQUIRED_PAGE_SCOPES.filter((scope) => !granted.has(scope));
        }
      } catch {}
    }

    return jsonOk({
      hasUserFacebookAccount: Boolean(user?.provider === "facebook" && user?.providerId),
      facebookAccountStatus: connection?.tokenStatus ?? "not_connected",
      connectedPageCount: connection?.pages?.length ?? 0,
      validPageTokenCount: (connection?.pages ?? []).filter((page: { pageAccessToken?: string }) => Boolean(page.pageAccessToken)).length,
      expiredCredentialCount: connection?.tokenStatus === "expired" ? 1 : 0,
      missingScopeList,
      lastSyncAt: connection?.lastSyncAt ?? connection?.updatedAt ?? connection?.connectedAt ?? null,
      lastErrorCode: connection?.lastErrorCode ?? null,
      lastValidatedAt: connection?.lastValidatedAt ?? null
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to inspect Facebook status right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
