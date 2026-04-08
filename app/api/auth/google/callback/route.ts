import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import {
  buildLoginErrorUrl,
  buildLoginSuccessUrl,
  getSocialRedirectUri,
  upsertSocialUser,
  verifyOAuthState
} from "@/lib/social-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(buildLoginErrorUrl(error));
  }

  if (!(await verifyOAuthState("google", state))) {
    return NextResponse.redirect(buildLoginErrorUrl("invalid_google_state"));
  }

  if (!code) {
    return NextResponse.redirect(buildLoginErrorUrl("missing_google_code"));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(buildLoginErrorUrl("missing_google_oauth"));
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getSocialRedirectUri("google"),
        grant_type: "authorization_code"
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      return NextResponse.redirect(buildLoginErrorUrl("google_token_exchange_failed"));
    }

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });
    const profile = await profileResponse.json();

    if (!profileResponse.ok || !profile.sub || !profile.email) {
      return NextResponse.redirect(buildLoginErrorUrl("google_profile_failed"));
    }

    const user = await upsertSocialUser({
      provider: "google",
      providerId: String(profile.sub),
      email: String(profile.email),
      name: String(profile.name || profile.email),
      avatar: typeof profile.picture === "string" ? profile.picture : null
    });

    await createSession(String(user._id));
    return NextResponse.redirect(buildLoginSuccessUrl());
  } catch {
    return NextResponse.redirect(buildLoginErrorUrl("google_login_failed"));
  }
}
