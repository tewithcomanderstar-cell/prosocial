import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { User } from "@/models/User";
import { connectDb } from "@/lib/db";
export { resolveFacebookLoginConfigId } from "@/lib/services/facebook-login-auth";

export type SocialProvider = "google" | "facebook";

type SocialProfile = {
  provider: SocialProvider;
  providerId: string;
  email: string;
  name: string;
  avatar?: string | null;
};

const STATE_COOKIE_PREFIX = "social_oauth_state_";
const POST_LOGIN_REDIRECT_COOKIE = "post_login_redirect";

function sanitizeRedirectPath(path: string | null | undefined) {
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return "/dashboard";
  }

  return path;
}

function getOAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10
  };
}

export function getBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function getRequestBaseUrl(requestOrUrl?: Request | URL | string | null) {
  if (!requestOrUrl) {
    return getBaseUrl();
  }

  if (typeof requestOrUrl === "string") {
    return new URL(requestOrUrl).origin;
  }

  if (requestOrUrl instanceof URL) {
    return requestOrUrl.origin;
  }

  return new URL(requestOrUrl.url).origin;
}

export function getSocialRedirectUri(provider: SocialProvider) {
  if (provider === "google") {
    return process.env.GOOGLE_AUTH_REDIRECT_URI || `${getBaseUrl()}/api/auth/google/callback`;
  }

  return process.env.FACEBOOK_AUTH_REDIRECT_URI || `${getBaseUrl()}/api/auth/facebook/callback`;
}

export function getSocialRedirectUriForRequest(provider: SocialProvider, requestOrUrl?: Request | URL | string | null) {
  const baseUrl = getRequestBaseUrl(requestOrUrl);

  if (provider === "google") {
    return `${baseUrl}/api/auth/google/callback`;
  }

  return `${baseUrl}/api/auth/facebook/callback`;
}

export async function createOAuthState(provider: SocialProvider) {
  const state = randomUUID();
  const store = await cookies();
  store.set(`${STATE_COOKIE_PREFIX}${provider}`, state, getOAuthCookieOptions());
  return state;
}

export function applyOAuthStartCookies(
  response: NextResponse,
  provider: SocialProvider,
  state: string,
  redirectPath: string | null | undefined
) {
  response.cookies.set(`${STATE_COOKIE_PREFIX}${provider}`, state, getOAuthCookieOptions());
  response.cookies.set(POST_LOGIN_REDIRECT_COOKIE, sanitizeRedirectPath(redirectPath), getOAuthCookieOptions());
  return response;
}

export async function setPostLoginRedirect(path: string | null | undefined) {
  const store = await cookies();
  store.set(POST_LOGIN_REDIRECT_COOKIE, sanitizeRedirectPath(path), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10
  });
}

export async function consumePostLoginRedirect() {
  const store = await cookies();
  const redirectPath = sanitizeRedirectPath(store.get(POST_LOGIN_REDIRECT_COOKIE)?.value ?? null);
  store.set(POST_LOGIN_REDIRECT_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/"
  });
  return redirectPath;
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

  const normalizedEmail = profile.email.trim().toLowerCase();

  const updatePayload: Record<string, unknown> = {
    name: profile.name,
    email: normalizedEmail,
    provider: profile.provider,
    providerId: profile.providerId
  };

  if (profile.avatar) {
    updatePayload.avatar = profile.avatar;
  }

  try {
    const providerUser = await User.findOne({
      provider: profile.provider,
      providerId: profile.providerId
    });

    const emailUser = await User.findOne({
      email: normalizedEmail
    });

    if (providerUser) {
      const targetUser =
        emailUser && String(emailUser._id) !== String(providerUser._id)
          ? emailUser
          : providerUser;

      if (emailUser && String(emailUser._id) !== String(providerUser._id)) {
        await User.findByIdAndUpdate(providerUser._id, {
          $unset: {
            provider: 1,
            providerId: 1
          }
        });
      }

      const updatedUser = await User.findByIdAndUpdate(
        targetUser._id,
        {
          $set: updatePayload
        },
        { new: true }
      );

      if (updatedUser) {
        return updatedUser;
      }
    }

    if (emailUser) {
      const updatedUser = await User.findByIdAndUpdate(
        emailUser._id,
        {
          $set: updatePayload
        },
        { new: true }
      );

      if (updatedUser) {
        return updatedUser;
      }
    }

    return await User.create({
      name: profile.name,
      email: normalizedEmail,
      provider: profile.provider,
      providerId: profile.providerId,
      avatar: profile.avatar ?? null,
      passwordHash: null,
      role: "admin",
      timezone: "Asia/Bangkok",
      locale: "th-TH"
    });
  } catch (error) {
    const duplicateKey = typeof error === "object" && error !== null && "code" in error && (error as { code?: number }).code === 11000;
    if (duplicateKey) {
      const existingUser = await User.findOne({
        $or: [
          { provider: profile.provider, providerId: profile.providerId },
          { email: normalizedEmail }
        ]
      });
      if (existingUser) {
        try {
          const updatedUser = await User.findByIdAndUpdate(
            existingUser._id,
            {
              $set: updatePayload
            },
            { new: true }
          );
          if (updatedUser) {
            return updatedUser;
          }
        } catch {}

        return existingUser;
      }
    }

    const providerUser = await User.findOne({
      provider: profile.provider,
      providerId: profile.providerId
    });
    if (providerUser) {
      return providerUser;
    }

    const emailUser = await User.findOne({
      email: normalizedEmail
    });
    if (emailUser) {
      return emailUser;
    }

    throw error;
  }
}

export function buildLoginErrorUrl(message: string, nextPath?: string | null, baseUrl?: string) {
  const url = new URL("/login", baseUrl || getBaseUrl());
  url.searchParams.set("error", message);

  const redirectPath = sanitizeRedirectPath(nextPath);
  if (redirectPath !== "/dashboard") {
    url.searchParams.set("next", redirectPath);
  }

  return url;
}

export async function buildLoginSuccessUrl() {
  const redirectPath = await consumePostLoginRedirect();
  return new URL(redirectPath, getBaseUrl());
}

export async function buildLoginSuccessUrlForRequest(requestOrUrl?: Request | URL | string | null) {
  const redirectPath = await consumePostLoginRedirect();
  return new URL(redirectPath, getRequestBaseUrl(requestOrUrl));
}
