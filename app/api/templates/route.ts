import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { requireRole, handleRoleError } from "@/lib/services/permissions";
import { ContentTemplate } from "@/models/ContentTemplate";

const schema = z.object({
  name: z.string().min(2),
  category: z.string().min(2),
  bodyTemplate: z.string().min(2),
  hashtagTemplate: z.array(z.string()).default([]),
  placeholders: z.array(z.string()).default([]),
  active: z.boolean().default(true)
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const templates = await ContentTemplate.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ templates });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const template = await ContentTemplate.create({ userId, ...payload });
    return jsonOk({ template }, "Template saved");
  } catch (error) {
    return handleRoleError(error);
  }
}
