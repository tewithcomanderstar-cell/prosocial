import { NextResponse } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { logAction, safeLogRouteError } from "@/lib/services/logging";
import { fetchWithRetry } from "@/lib/services/http";
import {
  buildLoginErrorUrl,
  buildLoginSuccessUrlForRequest,
  getSocialRedirectUriForRequest,
  upsertSocialUser,
  verifyOAuthState
} from "@/lib/social-auth";

const AUTH_LOG_USER_ID = "anonymous";

async function logGoogleAuthError(params: {
  message: string;
  error: unknown;
  metadata?: Record<string, unknown>;
}) {
  await safeLogRouteError({
    userId: AUTH_LOG_USER_ID,
    type: "auth",
    message: params.message,
    error: params.error,
    metadata: params.metadata
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    console.error("[google-login] provider returned an error", { error, url: request.url });
    await logGoogleAuthError({
      message: "Google login provider returned an error",
      error: new Error(String(error)),
      metadata: { stage: "provider-error", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl(error, null, url.origin));
  }

  if (!(await verifyOAuthState("google", state))) {
    console.error("[google-login] invalid state", { url: request.url });
    await logGoogleAuthError({
      message: "Google login state verification failed",
      error: new Error("invalid_google_state"),
      metadata: { stage: "state-check", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("invalid_google_state", null, url.origin));
  }

  if (!code) {
    console.error("[google-login] missing code", { url: request.url });
    await logGoogleAuthError({
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
    await logGoogleAuthError({
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
    const tokenResponse = await fetchWithRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getSocialRedirectUriForRequest("google", request),
        grant_type: "authorization_code"
      }),
      cache: "no-store"
    });

    const tokenData = await tokenResponse.json().catch(() => null) as { access_token?: string; error?: string; error_description?: string } | null;
    if (!tokenResponse.ok || !tokenData?.access_token) {
      console.error("[google-login] token exchange failed", { status: tokenResponse.status, hasAccessToken: Boolean(tokenData?.access_token) });
      await logGoogleAuthError({
        message: "Google token exchange failed",
        error: new Error(`google_token_exchange_failed:${tokenResponse.status}`),
        metadata: {
          stage: "token-exchange",
          status: tokenResponse.status,
          providerError: tokenData?.error_description ?? tokenData?.error ?? null
        }
      });
      return NextResponse.redirect(buildLoginErrorUrl("google_token_exchange_failed", null, url.origin));
    }

    const profileResponse = await fetchWithRetry("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      },
      cache: "no-store"
    });
    const profile = await profileResponse.json().catch(() => null) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
      error?: string;
      error_description?: string;
    } | null;

    if (!profileResponse.ok || !profile?.sub || !profile?.email) {
      console.error("[google-login] profile fetch failed", { status: profileResponse.status, hasSub: Boolean(profile?.sub), hasEmail: Boolean(profile?.email) });
      await logGoogleAuthError({
        message: "Google profile fetch failed",
        error: new Error(`google_profile_failed:${profileResponse.status}`),
        metadata: {
          stage: "profile-fetch",
          status: profileResponse.status,
          providerError: profile?.error_description ?? profile?.error ?? null
        }
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

    const response = NextResponse.redirect(await buildLoginSuccessUrlForRequest(request));
    await attachSessionCookie(response, String(user._id));
    try {
      await logAction({
        userId: String(user._id),
        type: "auth",
        level: "success",
        message: "Google login successful",
        metadata: { provider: "google", email: String(profile.email) }
      });
    } catch (loggingError) {
      console.error("[google-login] unable to persist success log", loggingError);
    }
    return response;
  } catch (error) {
    console.error("[google-login] unexpected failure", error);
    await logGoogleAuthError({
      message: "Google login failed unexpectedly",
      error,
      metadata: { stage: "callback-catch", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("google_login_failed", null, url.origin));
  }
}
