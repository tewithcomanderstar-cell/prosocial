import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { logAction, logRouteError } from "@/lib/services/logging";
import {
  buildLoginErrorUrl,
  buildLoginSuccessUrlForRequest,
  getSocialRedirectUriForRequest,
  upsertSocialUser,
  verifyOAuthState
} from "@/lib/social-auth";

const AUTH_LOG_USER_ID = "anonymous";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    console.error("[google-login] provider returned error", { error, url: request.url });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Google login provider returned an error",
      error: new Error(String(error)),
      metadata: { stage: "provider-error", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl(error, null, url.origin));
  }

  if (!(await verifyOAuthState("google", state))) {
    console.error("[google-login] invalid state", { url: request.url });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Google login state verification failed",
      error: new Error("invalid_google_state"),
      metadata: { stage: "state-check", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("invalid_google_state", null, url.origin));
  }

  if (!code) {
    console.error("[google-login] missing code", { url: request.url });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Google login callback did not include authorization code",
      error: new Error("missing_google_code"),
      metadata: { stage: "code-check", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("missing_google_code", null, url.origin));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("[google-login] missing oauth env", { hasClientId: Boolean(clientId), hasClientSecret: Boolean(clientSecret) });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Google login environment variables are missing",
      error: new Error("missing_google_oauth"),
      metadata: {
        stage: "env-check",
        hasClientId: Boolean(clientId),
        hasClientSecret: Boolean(clientSecret)
      }
    });
    return NextResponse.redirect(buildLoginErrorUrl("missing_google_oauth", null, url.origin));
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getSocialRedirectUriForRequest("google", request),
        grant_type: "authorization_code"
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("[google-login] token exchange failed", { status: tokenResponse.status, tokenData });
      await logRouteError({
        userId: AUTH_LOG_USER_ID,
        type: "auth",
        message: "Google token exchange failed",
        error: new Error(`google_token_exchange_failed:${tokenResponse.status}`),
        metadata: { stage: "token-exchange", status: tokenResponse.status, tokenData }
      });
      return NextResponse.redirect(buildLoginErrorUrl("google_token_exchange_failed", null, url.origin));
    }

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });
    const profile = await profileResponse.json();

    if (!profileResponse.ok || !profile.sub || !profile.email) {
      console.error("[google-login] profile fetch failed", { status: profileResponse.status, profile });
      await logRouteError({
        userId: AUTH_LOG_USER_ID,
        type: "auth",
        message: "Google profile fetch failed",
        error: new Error(`google_profile_failed:${profileResponse.status}`),
        metadata: { stage: "profile-fetch", status: profileResponse.status, profile }
      });
      return NextResponse.redirect(buildLoginErrorUrl("google_profile_failed", null, url.origin));
    }

    const user = await upsertSocialUser({
      provider: "google",
      providerId: String(profile.sub),
      email: String(profile.email),
      name: String(profile.name || profile.email),
      avatar: typeof profile.picture === "string" ? profile.picture : null
    });

    await connectDb();
    await createSession(String(user._id));
    await logAction({
      userId: String(user._id),
      type: "auth",
      level: "success",
      message: "Google login successful",
      metadata: { provider: "google", email: String(profile.email) }
    });
    return NextResponse.redirect(await buildLoginSuccessUrlForRequest(request));
  } catch (error) {
    console.error("[google-login] unexpected failure", error);
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Google login failed unexpectedly",
      error,
      metadata: { stage: "callback-catch", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("google_login_failed", null, url.origin));
  }
}


