import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { logAction } from "@/lib/services/logging";
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
  const error = url.searchParams.get("error") || url.searchParams.get("error_reason");

  if (error) {
    return NextResponse.redirect(buildLoginErrorUrl(String(error)));
  }

  if (!(await verifyOAuthState("facebook", state))) {
    return NextResponse.redirect(buildLoginErrorUrl("invalid_facebook_state"));
  }

  if (!code) {
    return NextResponse.redirect(buildLoginErrorUrl("missing_facebook_code"));
  }

  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(buildLoginErrorUrl("missing_facebook_oauth"));
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
      return NextResponse.redirect(buildLoginErrorUrl("facebook_token_exchange_failed"));
    }

    const profileUrl = new URL("https://graph.facebook.com/me");
    profileUrl.searchParams.set("fields", "id,name,email,picture.type(large)");
    profileUrl.searchParams.set("access_token", tokenData.access_token);

    const profileResponse = await fetch(profileUrl);
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.id || !profile.name) {
      return NextResponse.redirect(buildLoginErrorUrl("facebook_profile_failed"));
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
    return NextResponse.redirect(buildLoginSuccessUrl());
  } catch (error) {
    return NextResponse.redirect(buildLoginErrorUrl("facebook_login_failed"));
  }
}
