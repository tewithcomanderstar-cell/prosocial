import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { TeamMember } from "@/models/TeamMember";
import { Workspace } from "@/models/Workspace";

const schema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
  assignedPages: z.array(z.string()).default([])
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const workspaces = await Workspace.find({ ownerUserId: userId }).lean();
    const workspaceIds = workspaces.map((workspace) => workspace._id);
    const members = await TeamMember.find({ workspaceId: { $in: workspaceIds } }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ members });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    await requireRole(["admin"]);
    const payload = parseBody(schema, await request.json());
    const member = await TeamMember.findOneAndUpdate(
      { workspaceId: payload.workspaceId, userId: payload.userId },
      payload,
      { upsert: true, new: true }
    ).lean();
    return jsonOk({ member }, "Team member saved");
  } catch (error) {
    return handleRoleError(error);
  }
}
