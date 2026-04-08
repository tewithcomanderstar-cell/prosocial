import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { Workspace } from "@/models/Workspace";

const schema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2),
  timezone: z.string().default("Asia/Bangkok"),
  locale: z.string().default("th-TH"),
  plan: z.enum(["free", "pro", "business"]).default("free")
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const workspaces = await Workspace.find({ ownerUserId: userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ workspaces });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());
    const workspace = await Workspace.create({ ownerUserId: userId, ...payload, pageLimit: payload.plan === "business" ? 100 : payload.plan === "pro" ? 20 : 5 });
    return jsonOk({ workspace }, "Workspace created");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create workspace");
  }
}
