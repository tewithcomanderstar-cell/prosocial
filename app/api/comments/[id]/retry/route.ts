import { after } from "next/server";
import { jsonError, jsonOk } from "@/lib/api";
import { retryCommentReply } from "@/lib/services/comment-automation";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { processCommentReplyJobs } from "@/lib/services/queue";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const { id } = await context.params;
    const result = await retryCommentReply(userId, id);
    after(async () => {
      try {
        await processCommentReplyJobs(3);
      } catch (error) {
        console.error("[COMMENTS] deferred retry processing failed", error);
      }
    });
    return jsonOk(result, "Comment reply re-queued");
  } catch (error) {
    if (error instanceof Error && error.message === "Comment inbox entry not found") {
      return jsonError(error.message, 404);
    }
    return handleRoleError(error);
  }
}
