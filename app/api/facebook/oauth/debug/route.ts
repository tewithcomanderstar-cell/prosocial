import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { getFacebookPageConnectDebugInfo, getFacebookOAuthUrl } from "@/lib/services/facebook";

export async function GET() {
  try {
    await requireAuth();
    const debug = getFacebookPageConnectDebugInfo();
    const oauthUrl = getFacebookOAuthUrl();
    const parsedUrl = new URL(oauthUrl);

    return jsonOk({
      ...debug,
      oauthDialogHost: parsedUrl.origin,
      oauthDialogPath: parsedUrl.pathname,
      oauthDialogScope: parsedUrl.searchParams.get("scope"),
      oauthDialogRedirectUri: parsedUrl.searchParams.get("redirect_uri")
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to load Facebook OAuth debug info right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
