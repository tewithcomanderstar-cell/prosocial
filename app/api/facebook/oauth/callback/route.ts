import { NextResponse } from "next/server";
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

  return "oauth_failed";
}

export async function GET(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");

    if (!code) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/facebook?error=missing_code`);
    }

    const tokenPayload = await exchangeFacebookCode(code);
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

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/connections/facebook?success=1`);
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
      `${process.env.NEXT_PUBLIC_APP_URL}/connections/facebook?error=${errorCode}`
    );
  }
}
