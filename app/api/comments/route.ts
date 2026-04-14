import { z } from "zod";
import { isUnauthorizedError, jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { ingestCommentAndMaybeQueue } from "@/lib/services/comment-automation";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { processCommentReplyJobs } from "@/lib/services/queue";
import { CommentInbox } from "@/models/CommentInbox";

const schema = z.object({
  pageId: z.string().min(1),
  authorName: z.string().min(1),
  message: z.string().min(1),
  externalCommentId: z.string().optional(),
  replyText: z.string().optional(),
  autoQueue: z.boolean().optional()
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const comments = await CommentInbox.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return jsonOk({ comments });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load comments", isUnauthorizedError(error) ? 401 : 500);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const result = await ingestCommentAndMaybeQueue({
      userId,
      pageId: payload.pageId,
      authorName: payload.authorName,
      message: payload.message,
      externalCommentId: payload.externalCommentId,
      replyText: payload.replyText,
      autoQueue: payload.autoQueue
    });
    const processedJobs = result.queuedJobId ? await processCommentReplyJobs(1) : [];
    return jsonOk({ ...result, processedJobs }, result.queuedJobId ? "Comment reply queued" : "Comment inbox updated");
  } catch (error) {
    return handleRoleError(error);
  }
}
