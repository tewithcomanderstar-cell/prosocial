import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { GrowthAutomationRule } from "@/models/GrowthAutomationRule";

const schema = z.object({
  name: z.string().min(2),
  triggerKeyword: z.string().min(1),
  actionType: z.enum(["invite-inbox", "send-link", "custom-reply"]),
  replyText: z.string().min(2),
  linkUrl: z.string().optional(),
  enabled: z.boolean().default(true)
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const rules = await GrowthAutomationRule.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ rules });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const rule = await GrowthAutomationRule.create({ userId, ...payload });
    return jsonOk({ rule }, "Growth automation rule saved");
  } catch (error) {
    return handleRoleError(error);
  }
}
