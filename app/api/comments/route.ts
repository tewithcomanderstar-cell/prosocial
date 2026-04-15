import { after } from "next/server";
import { z } from "zod";
import { isUnauthorizedError, jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { ingestCommentAndMaybeQueue } from "@/lib/services/comment-automation";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { processCommentReplyJobs } from "@/lib/services/queue";
import { CommentInbox } from "@/models/CommentInbox";
import { CommentExecutionLog } from "@/models/CommentExecutionLog";

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
    const commentIds = comments.map((comment) => String(comment._id));
    const logs = commentIds.length
      ? await CommentExecutionLog.find({ commentInboxId: { $in: commentIds } }).sort({ createdAt: -1 }).lean()
      : [];

    const logsByCommentId = logs.reduce<Record<string, unknown[]>>((acc, log) => {
      const key = String(log.commentInboxId);
      if (!acc[key]) {
        acc[key] = [];
      }
      if (acc[key].length < 5) {
        acc[key].push(log);
      }
      return acc;
    }, {});

    return jsonOk({
      comments: comments.map((comment) => ({
        ...comment,
        executionLogs: logsByCommentId[String(comment._id)] ?? []
      }))
    });
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
    if (result.queuedJobId) {
      after(async () => {
        try {
          await processCommentReplyJobs(1);
        } catch (error) {
          console.error("[COMMENTS] deferred comment reply processing failed", error);
        }
      });
    }
    return jsonOk(result, result.queuedJobId ? "Comment reply queued" : "Comment inbox updated");
  } catch (error) {
    return handleRoleError(error);
  }
}
