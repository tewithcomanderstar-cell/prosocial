import { ingestFacebookWebhookPayload } from "@/lib/services/comment-automation";
import { jsonError, jsonOk } from "@/lib/api";
import { processCommentReplyJobs } from "@/lib/services/queue";

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
    const processedJobs = result.accepted > 0 ? await processCommentReplyJobs(Math.min(result.accepted, 5)) : [];
    return jsonOk({ ...result, processedJobs }, "Facebook webhook processed");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process webhook", 500);
  }
}
