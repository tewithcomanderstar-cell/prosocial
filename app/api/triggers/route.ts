import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { requireRole, handleRoleError } from "@/lib/services/permissions";
import { KeywordTrigger } from "@/models/KeywordTrigger";

const schema = z.object({
  keyword: z.string().min(1),
  triggerType: z.enum(["post", "comment"]),
  action: z.string().min(2),
  replyText: z.string().optional(),
  enabled: z.boolean().default(true)
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const triggers = await KeywordTrigger.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ triggers });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const trigger = await KeywordTrigger.create({ userId, ...payload });
    return jsonOk({ trigger }, "Keyword trigger saved");
  } catch (error) {
    return handleRoleError(error);
  }
}
