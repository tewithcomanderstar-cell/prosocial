import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { PostApproval } from "@/models/PostApproval";

const schema = z.object({
  postId: z.string().min(1),
  assignedToUserId: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  note: z.string().optional()
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const approvals = await PostApproval.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ approvals });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const approval = await PostApproval.findOneAndUpdate(
      { userId, postId: payload.postId },
      { ...payload, userId, requestedByUserId: userId },
      { upsert: true, new: true }
    ).lean();
    return jsonOk({ approval }, "Approval flow updated");
  } catch (error) {
    return handleRoleError(error);
  }
}
