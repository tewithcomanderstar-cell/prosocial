import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { getRequestBaseUrl } from "@/lib/social-auth";
import { getGoogleOAuthUrl } from "@/lib/services/google-drive";

const GOOGLE_DRIVE_STATE_COOKIE = "google_drive_oauth_state";
const GOOGLE_DRIVE_REDIRECT_COOKIE = "google_drive_redirect_uri";

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10
  };
}

export async function GET(request: Request) {
  try {
    await requireAuth();
    const state = randomUUID();
    const redirectUri = `${getRequestBaseUrl(request)}/api/google-drive/oauth/callback`;
    const store = await cookies();
    store.set(GOOGLE_DRIVE_STATE_COOKIE, state, getCookieOptions());
    store.set(GOOGLE_DRIVE_REDIRECT_COOKIE, redirectUri, getCookieOptions());
    const url = getGoogleOAuthUrl({ redirectUri, state });

    return jsonOk({ url });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to start Google Drive connection right now.");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
