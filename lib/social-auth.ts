import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { User } from "@/models/User";
import { connectDb } from "@/lib/db";

export type SocialProvider = "google" | "facebook";

type SocialProfile = {
  provider: SocialProvider;
  providerId: string;
  email: string;
  name: string;
  avatar?: string | null;
};

const STATE_COOKIE_PREFIX = "social_oauth_state_";

export function getBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function getSocialRedirectUri(provider: SocialProvider) {
  if (provider === "google") {
    return process.env.GOOGLE_AUTH_REDIRECT_URI || `${getBaseUrl()}/api/auth/google/callback`;
  }

  return process.env.FACEBOOK_AUTH_REDIRECT_URI || `${getBaseUrl()}/api/auth/facebook/callback`;
}

export async function createOAuthState(provider: SocialProvider) {
  const state = randomUUID();
  const store = await cookies();
  store.set(`${STATE_COOKIE_PREFIX}${provider}`, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10
  });
  return state;
}

export async function verifyOAuthState(provider: SocialProvider, state: string | null) {
  const store = await cookies();
  const key = `${STATE_COOKIE_PREFIX}${provider}`;
  const savedState = store.get(key)?.value;
  store.set(key, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/"
  });

  return Boolean(state && savedState && savedState === state);
}

export async function upsertSocialUser(profile: SocialProfile) {
  await connectDb();

  let user = await User.findOne({
    $or: [
      { provider: profile.provider, providerId: profile.providerId },
      { email: profile.email }
    ]
  });

  if (!user) {
    user = await User.create({
      name: profile.name,
      email: profile.email,
      provider: profile.provider,
      providerId: profile.providerId,
      avatar: profile.avatar ?? null,
      passwordHash: null,
      role: "admin",
      timezone: "Asia/Bangkok",
      locale: "th-TH"
    });

    return user;
  }

  user.name = profile.name || user.name;
  user.email = profile.email || user.email;
  user.provider = profile.provider;
  user.providerId = profile.providerId;
  if (profile.avatar) {
    user.avatar = profile.avatar;
  }

  await user.save();
  return user;
}

export function buildLoginErrorUrl(message: string) {
  const url = new URL("/login", getBaseUrl());
  url.searchParams.set("error", message);
  return url;
}

export function buildLoginSuccessUrl() {
  return new URL("/", getBaseUrl());
}
