import { after } from "next/server";
import { ingestFacebookWebhookPayload } from "@/lib/services/comment-automation";
import { jsonError, jsonOk } from "@/lib/api";
import { processCommentReplyJobs } from "@/lib/services/queue";
import { logAction } from "@/lib/services/logging";
import { connectDb } from "@/lib/db";
import { FacebookConnection } from "@/models/FacebookConnection";

function getVerifyToken() {
  return process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || process.env.CRON_SECRET || "";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const verifyToken = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && verifyToken && verifyToken === getVerifyToken() && challenge) {
    return new Response(challenge, { status: 200 });
  }

  return jsonError("Webhook verification failed", 403);
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const result = await ingestFacebookWebhookPayload(payload);
    await connectDb();
    const entryPageIds = (payload?.entry ?? []).map((entry: { id?: string }) => entry?.id).filter(Boolean);
    const owners = entryPageIds.length
      ? await FacebookConnection.find({ "pages.pageId": { $in: entryPageIds } }).select("userId pages.pageId").lean()
      : [];

    await Promise.all(
      owners.map(async (owner) => {
        await logAction({
          userId: String(owner.userId),
          type: "comment",
          level: result.accepted > 0 ? "success" : "warn",
          message:
            result.accepted > 0
              ? "Facebook comment webhook received"
              : "Facebook webhook arrived but no comment was accepted",
          metadata: {
            accepted: result.accepted,
            ignored: result.ignored,
            reasons: result.reasons,
            pageIds: entryPageIds
          }
        });
      })
    );

    if (result.accepted > 0) {
      after(async () => {
        try {
          await processCommentReplyJobs(result.accepted);
        } catch (error) {
          console.error("[WEBHOOK] deferred comment reply processing failed", error);
        }
      });
    }
    return jsonOk(result, "Facebook webhook accepted");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process webhook", 500);
  }
}
