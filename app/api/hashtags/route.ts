import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { HashtagSet } from "@/models/HashtagSet";

const schema = z.object({
  name: z.string().min(1),
  category: z.string().default("general"),
  hashtags: z.array(z.string()).default([])
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const sets = await HashtagSet.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ sets });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const set = await HashtagSet.create({ userId, ...payload });
    return jsonOk({ set }, "Hashtag set saved");
  } catch (error) {
    return handleRoleError(error);
  }
}
