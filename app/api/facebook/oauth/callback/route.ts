import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireAuth } from "@/lib/api";
import { FacebookConnection } from "@/models/FacebookConnection";
import { connectDb } from "@/lib/db";
import {
  FacebookOAuthError,
  exchangeFacebookCode,
  fetchFacebookPages,
  subscribePageToWebhook
} from "@/lib/services/facebook";
import { logAction } from "@/lib/services/logging";

const FACEBOOK_PAGE_STATE_COOKIE = "facebook_pages_oauth_state";
const FACEBOOK_PAGE_REDIRECT_COOKIE = "facebook_pages_redirect_uri";

function mapCallbackErrorCode(error: unknown) {
  if (error instanceof FacebookOAuthError) {
    return error.code;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("supported permission")) {
    return "unsupported_permission";
  }

  if (
    message.includes("permission") ||
    message.includes("developer") ||
    message.includes("tester") ||
    message.includes("admin")
  ) {
    return "permission_denied";
  }

  if (message.includes("redirect_uri") || message.includes("url blocked")) {
    return "invalid_redirect";
  }

  if (message.includes("state")) {
    return "invalid_state";
  }

  return "oauth_failed";
}

async function consumeFacebookPageOAuthState() {
  const store = await cookies();
  const savedState = store.get(FACEBOOK_PAGE_STATE_COOKIE)?.value ?? null;
  const redirectUri = store.get(FACEBOOK_PAGE_REDIRECT_COOKIE)?.value ?? null;

  store.set(FACEBOOK_PAGE_STATE_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/"
  });
  store.set(FACEBOOK_PAGE_REDIRECT_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/"
  });

  return {
    savedState,
    redirectUri
  };
}

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const url = new URL(request.url);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || url.origin;
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const { savedState, redirectUri } = await consumeFacebookPageOAuthState();

    if (!code) {
      return NextResponse.redirect(`${appUrl}/connections/facebook?error=missing_code`);
    }

    if (!savedState || !returnedState || savedState !== returnedState) {
      return NextResponse.redirect(`${appUrl}/connections/facebook?error=invalid_state`);
    }

    const tokenPayload = await exchangeFacebookCode(code, redirectUri);
    const pages = await fetchFacebookPages(tokenPayload.access_token);
    const webhookResults = await Promise.allSettled(
      pages.map(async (page) => {
        await subscribePageToWebhook(page.pageId, page.pageAccessToken);
        return page.pageId;
      })
    );

    const subscribedPageIds = webhookResults
      .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
      .map((result) => result.value);
    const failedSubscriptions = webhookResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : "unknown"));

    await FacebookConnection.findOneAndUpdate(
      { userId },
      {
        userId,
        accessToken: tokenPayload.access_token,
        pages,
        connectedAt: new Date(),
        expiresAt: tokenPayload.expires_in ? new Date(Date.now() + tokenPayload.expires_in * 1000) : null,
        tokenStatus: "healthy",
        lastValidatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    await logAction({
      userId,
      type: "auth",
      level: "success",
      message: "Facebook Pages connected successfully",
      metadata: {
        pagesConnected: pages.length,
        pagesSubscribedToWebhook: subscribedPageIds.length,
        webhookSubscriptionFailures: failedSubscriptions
      }
    });

    return NextResponse.redirect(`${appUrl}/connections/facebook?success=1`);
  } catch (error) {
    const errorCode = mapCallbackErrorCode(error);

    try {
      const userId = await requireAuth();
      await logAction({
        userId,
        type: "error",
        level: "error",
        message: "Facebook connection failed",
        metadata: {
          errorCode,
          reason: error instanceof Error ? error.message : "unknown"
        }
      });
    } catch {}

    return NextResponse.redirect(
      `${(process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin)}/connections/facebook?error=${errorCode}`
    );
  }
}
