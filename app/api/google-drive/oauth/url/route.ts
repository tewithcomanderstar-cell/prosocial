import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getRequestBaseUrl } from "@/lib/social-auth";

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
    if (!process.env.GOOGLE_CLIENT_ID) {
      return jsonError("missing_google_oauth", 500, "missing_env_var");
    }
    const state = randomUUID();
    const redirectUri = `${getRequestBaseUrl(request)}/api/google-drive/oauth/callback`;
    const store = await cookies();
    store.set(GOOGLE_DRIVE_STATE_COOKIE, state, getCookieOptions());
    store.set(GOOGLE_DRIVE_REDIRECT_COOKIE, redirectUri, getCookieOptions());

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set(
      "scope",
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email"
    );
    url.searchParams.set("state", state);

    return jsonOk({ url: url.toString() });
  } catch {
    return jsonError("Please login before connecting Google Drive", 401);
  }
}
