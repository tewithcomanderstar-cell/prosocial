import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { CommentInbox } from "@/models/CommentInbox";

const schema = z.object({
  pageId: z.string().min(1),
  authorName: z.string().min(1),
  message: z.string().min(1),
  externalCommentId: z.string().optional(),
  replyText: z.string().optional(),
  status: z.enum(["pending", "replied"]).default("pending"),
  matchedTrigger: z.string().optional()
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const comments = await CommentInbox.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return jsonOk({ comments });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const comment = await CommentInbox.create({
      userId,
      ...payload,
      repliedAt: payload.status === "replied" ? new Date() : undefined
    });
    return jsonOk({ comment }, "Comment inbox updated");
  } catch (error) {
    return handleRoleError(error);
  }
}
