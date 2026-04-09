import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { logAction, logRouteError } from "@/lib/services/logging";
import {
  buildLoginErrorUrl,
  buildLoginSuccessUrlForRequest,
  getSocialRedirectUri,
  upsertSocialUser,
  verifyOAuthState
} from "@/lib/social-auth";

const AUTH_LOG_USER_ID = "anonymous";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error") || url.searchParams.get("error_reason");

  if (error) {
    console.error("[facebook-login] provider returned error", { error, url: request.url });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Facebook login provider returned an error",
      error: new Error(String(error)),
      metadata: { stage: "provider-error", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl(String(error), null, url.origin));
  }

  if (!(await verifyOAuthState("facebook", state))) {
    console.error("[facebook-login] invalid state", { url: request.url });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Facebook login state verification failed",
      error: new Error("invalid_facebook_state"),
      metadata: { stage: "state-check", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("invalid_facebook_state", null, url.origin));
  }

  if (!code) {
    console.error("[facebook-login] missing code", { url: request.url });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Facebook login callback did not include authorization code",
      error: new Error("missing_facebook_code"),
      metadata: { stage: "code-check", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("missing_facebook_code", null, url.origin));
  }

  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;

  if (!clientId || !clientSecret) {
    console.error("[facebook-login] missing oauth env", { hasClientId: Boolean(clientId), hasClientSecret: Boolean(clientSecret) });
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Facebook login environment variables are missing",
      error: new Error("missing_facebook_oauth"),
      metadata: {
        stage: "env-check",
        hasClientId: Boolean(clientId),
        hasClientSecret: Boolean(clientSecret)
      }
    });
    return NextResponse.redirect(buildLoginErrorUrl("missing_facebook_oauth", null, url.origin));
  }

  try {
    const tokenUrl = new URL("https://graph.facebook.com/v20.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("redirect_uri", getSocialRedirectUri("facebook"));
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("[facebook-login] token exchange failed", { status: tokenResponse.status, tokenData });
      await logRouteError({
        userId: AUTH_LOG_USER_ID,
        type: "auth",
        message: "Facebook token exchange failed",
        error: new Error(`facebook_token_exchange_failed:${tokenResponse.status}`),
        metadata: { stage: "token-exchange", status: tokenResponse.status, tokenData }
      });
      return NextResponse.redirect(buildLoginErrorUrl("facebook_token_exchange_failed", null, url.origin));
    }

    const profileUrl = new URL("https://graph.facebook.com/me");
    profileUrl.searchParams.set("fields", "id,name,email,picture.type(large)");
    profileUrl.searchParams.set("access_token", tokenData.access_token);

    const profileResponse = await fetch(profileUrl);
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.id || !profile.name) {
      console.error("[facebook-login] profile fetch failed", { status: profileResponse.status, profile });
      await logRouteError({
        userId: AUTH_LOG_USER_ID,
        type: "auth",
        message: "Facebook profile fetch failed",
        error: new Error(`facebook_profile_failed:${profileResponse.status}`),
        metadata: { stage: "profile-fetch", status: profileResponse.status, profile }
      });
      return NextResponse.redirect(buildLoginErrorUrl("facebook_profile_failed", null, url.origin));
    }

    const email = typeof profile.email === "string" && profile.email.length > 0
      ? profile.email
      : `${profile.id}@facebook.local`;

    const user = await upsertSocialUser({
      provider: "facebook",
      providerId: String(profile.id),
      email,
      name: String(profile.name),
      avatar: profile.picture?.data?.url ?? null
    });

    await connectDb();
    await createSession(String(user._id));
    await logAction({
      userId: String(user._id),
      type: "auth",
      level: "success",
      message: "Facebook login successful",
      metadata: { provider: "facebook", email }
    });
    return NextResponse.redirect(await buildLoginSuccessUrlForRequest(request));
  } catch (error) {
    console.error("[facebook-login] unexpected failure", error);
    await logRouteError({
      userId: AUTH_LOG_USER_ID,
      type: "auth",
      message: "Facebook login failed unexpectedly",
      error,
      metadata: { stage: "callback-catch", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("facebook_login_failed", null, url.origin));
  }
}

