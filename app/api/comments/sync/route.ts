import { jsonOk } from "@/lib/api";
import { syncTrackedAutoCommentPosts } from "@/lib/services/comment-automation";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { processCommentReplyJobs } from "@/lib/services/queue";

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const syncSummary = await syncTrackedAutoCommentPosts(userId, { force: true });
    const processedReplies = await processCommentReplyJobs(5);

    return jsonOk(
      {
        ...syncSummary,
        processedReplies
      },
      "Auto Comment synced tracked post IDs"
    );
  } catch (error) {
    return handleRoleError(error);
  }
}
