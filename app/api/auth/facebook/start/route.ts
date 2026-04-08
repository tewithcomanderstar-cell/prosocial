import { NextResponse } from "next/server";
import { createOAuthState, getSocialRedirectUri } from "@/lib/social-auth";

export async function GET() {
  const clientId = process.env.FACEBOOK_APP_ID;

  if (!clientId) {
    return NextResponse.redirect(new URL("/login?error=missing_facebook_oauth", process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"));
  }

  const state = await createOAuthState("facebook");
  const url = new URL("https://www.facebook.com/v20.0/dialog/oauth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getSocialRedirectUri("facebook"));
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "email,public_profile");

  return NextResponse.redirect(url);
}
