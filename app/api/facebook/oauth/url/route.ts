import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { FacebookOAuthError, getFacebookOAuthUrl } from "@/lib/services/facebook";
import { getRequestBaseUrl } from "@/lib/social-auth";

const FACEBOOK_PAGE_STATE_COOKIE = "facebook_pages_oauth_state";
const FACEBOOK_PAGE_REDIRECT_COOKIE = "facebook_pages_redirect_uri";

function getOAuthCookieOptions() {
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

    const redirectUri = new URL("/api/facebook/oauth/callback", getRequestBaseUrl(request)).toString();
    const state = randomUUID();
    const url = new URL(getFacebookOAuthUrl({ redirectUri }));
    url.searchParams.set("state", state);

    const response = jsonOk({ url: url.toString() });
    response.cookies.set(FACEBOOK_PAGE_STATE_COOKIE, state, getOAuthCookieOptions());
    response.cookies.set(FACEBOOK_PAGE_REDIRECT_COOKIE, redirectUri, getOAuthCookieOptions());
    return response;
  } catch (error) {
    if (error instanceof FacebookOAuthError) {
      return jsonError(error.code, 400);
    }

    const normalized = normalizeRouteError(error, "Please login before connecting Facebook");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
