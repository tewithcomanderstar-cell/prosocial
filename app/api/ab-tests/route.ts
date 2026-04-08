import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { ABTest } from "@/models/ABTest";

const schema = z.object({
  name: z.string().min(2),
  postIds: z.array(z.string()).min(2),
  testMode: z.enum(["different-pages", "different-times"]).default("different-times")
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const tests = await ABTest.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ tests });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const test = await ABTest.create({ userId, ...payload, status: "draft" });
    return jsonOk({ test }, "A/B test created");
  } catch (error) {
    return handleRoleError(error);
  }
}
