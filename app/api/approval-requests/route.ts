import { z } from "zod";
import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { mapLegacyApprovalToApprovalRequest } from "@/lib/domain/mappers";
import { Post } from "@/models/Post";
import { PostApproval } from "@/models/PostApproval";
import { handleRoleError, requireRole } from "@/lib/services/permissions";

const updateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["approved", "rejected", "pending"]),
  comment: z.string().optional()
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const [approvals, posts] = await Promise.all([
      PostApproval.find({ userId }).sort({ updatedAt: -1 }).lean(),
      Post.find({ userId }).select({ _id: 1, title: 1 }).lean()
    ]);

    const postTitles = new Map(posts.map((post) => [String(post._id), post.title]));
    const items = approvals.map((approval) => ({
      ...mapLegacyApprovalToApprovalRequest(approval as Record<string, unknown>),
      contentTitle: postTitles.get(String(approval.postId)) || "Untitled content"
    }));

    const summary = {
      total: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      approved: items.filter((item) => item.status === "approved").length,
      rejected: items.filter((item) => item.status === "rejected").length
    };

    return jsonOk({ items, summary });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireRole(["admin", "editor"]);
    const payload = updateSchema.parse(await request.json());

    const approval = await PostApproval.findByIdAndUpdate(
      payload.id,
      {
        $set: {
          status: payload.status,
          note: payload.comment || "",
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();

    if (!approval) {
      return jsonError("Approval request not found", 404);
    }

    return jsonOk({ approval: mapLegacyApprovalToApprovalRequest(approval as Record<string, unknown>) }, "Approval request updated");
  } catch (error) {
    return handleRoleError(error);
  }
}
