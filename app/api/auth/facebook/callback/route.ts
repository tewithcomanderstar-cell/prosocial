import { NextResponse } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { User } from "@/models/User";
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

async function logFacebookAuthError(params: {
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

function mapFacebookLoginFailure(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: string | number }).code ?? "")
    : "";

  if (message.includes("jwt_secret")) {
    return "session_config_error";
  }

  if (
    message.includes("mongodb_uri") ||
    message.includes("server selection timed out") ||
    message.includes("connect econnrefused") ||
    message.includes("querysrv") ||
    message.includes("socket timeout")
  ) {
    return "auth_storage_unavailable";
  }

  if (
    message.includes("timed out") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("enotfound")
  ) {
    return "facebook_provider_unavailable";
  }

  if (
    message.includes("duplicate key") ||
    message.includes("validation failed") ||
    message.includes("social_user_upsert_failed") ||
    code === "11000"
  ) {
    return "facebook_account_link_failed";
  }

  return "facebook_login_failed";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error") || url.searchParams.get("error_reason");

  if (error) {
    console.error("[facebook-login] provider returned error", { error, url: request.url });
    await logFacebookAuthError({
      message: "Facebook login provider returned an error",
      error: new Error(String(error)),
      metadata: { stage: "provider-error", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl(String(error), null, url.origin));
  }

  if (!(await verifyOAuthState("facebook", state))) {
    console.error("[facebook-login] invalid state", { url: request.url });
    await logFacebookAuthError({
      message: "Facebook login state verification failed",
      error: new Error("invalid_facebook_state"),
      metadata: { stage: "state-check", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl("invalid_facebook_state", null, url.origin));
  }

  if (!code) {
    console.error("[facebook-login] missing code", { url: request.url });
    await logFacebookAuthError({
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
    await logFacebookAuthError({
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
    const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("redirect_uri", getSocialRedirectUriForRequest("facebook", request));
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetchWithRetry(tokenUrl, { cache: "no-store" });
    const tokenData = await tokenResponse.json().catch(() => null) as { access_token?: string; error?: { message?: string } } | null;
    if (!tokenResponse.ok || !tokenData?.access_token) {
      console.error("[facebook-login] token exchange failed", { status: tokenResponse.status, hasAccessToken: Boolean(tokenData?.access_token) });
      await logFacebookAuthError({
        message: "Facebook token exchange failed",
        error: new Error(`facebook_token_exchange_failed:${tokenResponse.status}`),
        metadata: {
          stage: "token-exchange",
          status: tokenResponse.status,
          providerError: tokenData?.error?.message ?? null
        }
      });
      return NextResponse.redirect(buildLoginErrorUrl("facebook_token_exchange_failed", null, url.origin));
    }

    const profileUrl = new URL("https://graph.facebook.com/me");
    profileUrl.searchParams.set("fields", "id,name,email,picture.type(large)");
    profileUrl.searchParams.set("access_token", tokenData.access_token);

    const profileResponse = await fetchWithRetry(profileUrl, { cache: "no-store" });
    const profile = await profileResponse.json().catch(() => null) as {
      id?: string;
      name?: string;
      email?: string;
      picture?: { data?: { url?: string } };
      error?: { message?: string };
    } | null;

    if (!profileResponse.ok || !profile?.id || !profile?.name) {
      console.error("[facebook-login] profile fetch failed", { status: profileResponse.status, hasId: Boolean(profile?.id), hasName: Boolean(profile?.name) });
      await logFacebookAuthError({
        message: "Facebook profile fetch failed",
        error: new Error(`facebook_profile_failed:${profileResponse.status}`),
        metadata: {
          stage: "profile-fetch",
          status: profileResponse.status,
          providerError: profile?.error?.message ?? null
        }
      });
      return NextResponse.redirect(buildLoginErrorUrl("facebook_profile_failed", null, url.origin));
    }

    const email = typeof profile.email === "string" && profile.email.length > 0
      ? profile.email
      : `${profile.id}@facebook.local`;

    let user;
    try {
      user = await upsertSocialUser({
        provider: "facebook",
        providerId: String(profile.id),
        email,
        name: String(profile.name),
        avatar: profile.picture?.data?.url ?? null
      });
    } catch (userError) {
      console.error("[facebook-login] social user upsert failed", userError);
      await logFacebookAuthError({
        message: "Facebook account link failed while upserting user",
        error: userError,
        metadata: {
          stage: "user-upsert",
          providerId: profile.id,
          hasEmail: Boolean(profile.email)
        }
      });

      const recoveryEmail = email.trim().toLowerCase();
      user =
        (await User.findOne({
          provider: "facebook",
          providerId: String(profile.id)
        })) ||
        (await User.findOne({
          email: recoveryEmail
        }));

      if (!user) {
        return NextResponse.redirect(buildLoginErrorUrl("facebook_account_link_failed", null, url.origin));
      }
    }

    const response = NextResponse.redirect(await buildLoginSuccessUrlForRequest(request));
    try {
      await attachSessionCookie(response, String(user._id));
    } catch (sessionError) {
      console.error("[facebook-login] attach session failed", sessionError);
      await logFacebookAuthError({
        message: "Facebook login failed while attaching session cookie",
        error: sessionError,
        metadata: {
          stage: "session-attach",
          userId: String(user._id)
        }
      });
      return NextResponse.redirect(buildLoginErrorUrl("session_config_error", null, url.origin));
    }
    try {
      await logAction({
        userId: String(user._id),
        type: "auth",
        level: "success",
        message: "Facebook login successful",
        metadata: { provider: "facebook", email }
      });
    } catch (loggingError) {
      console.error("[facebook-login] unable to persist success log", loggingError);
    }
    return response;
  } catch (error) {
    console.error("[facebook-login] unexpected failure", error);
    await logFacebookAuthError({
      message: "Facebook login failed unexpectedly",
      error,
      metadata: { stage: "callback-catch", url: request.url }
    });
    return NextResponse.redirect(buildLoginErrorUrl(mapFacebookLoginFailure(error), null, url.origin));
  }
}
