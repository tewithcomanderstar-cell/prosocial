import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { applyOAuthStartCookies, getRequestBaseUrl, getSocialRedirectUriForRequest } from "@/lib/social-auth";

export async function GET(request: Request) {
  const clientId = process.env.FACEBOOK_APP_ID;
  const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID;
  const useConfigId = process.env.FACEBOOK_LOGIN_USE_CONFIG_ID === "true";
  const requestUrl = new URL(request.url);
  const requestBaseUrl = getRequestBaseUrl(request);

  if (!clientId) {
    return NextResponse.redirect(new URL("/login?error=missing_facebook_oauth", requestBaseUrl));
  }

  const state = randomUUID();
  const url = new URL("https://www.facebook.com/v20.0/dialog/oauth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getSocialRedirectUriForRequest("facebook", request));
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");

  if (configId && useConfigId) {
    url.searchParams.set("config_id", configId);
  } else {
    url.searchParams.set("scope", "email,public_profile");
  }

  const response = NextResponse.redirect(url);
  applyOAuthStartCookies(response, "facebook", state, requestUrl.searchParams.get("next"));
  return response;
}
