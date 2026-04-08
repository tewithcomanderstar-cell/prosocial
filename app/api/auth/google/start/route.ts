import { NextResponse } from "next/server";
import { createOAuthState, getSocialRedirectUri } from "@/lib/social-auth";

export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return NextResponse.redirect(new URL("/login?error=missing_google_oauth", process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"));
  }

  const state = await createOAuthState("google");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getSocialRedirectUri("google"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");

  return NextResponse.redirect(url);
}
