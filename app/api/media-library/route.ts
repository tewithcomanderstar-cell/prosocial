import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { MediaAsset } from "@/models/MediaAsset";

const schema = z.object({
  title: z.string().min(1),
  type: z.enum(["image", "video", "caption"]).default("image"),
  category: z.string().default("general"),
  sourceUrl: z.string().optional(),
  driveFileId: z.string().optional(),
  caption: z.string().default(""),
  tags: z.array(z.string()).default([])
});

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const url = new URL(request.url);
    const query = url.searchParams.get("q") || "";
    const category = url.searchParams.get("category") || "";

    const filter: Record<string, unknown> = { userId };
    if (query) {
      filter.$or = [
        { title: { $regex: query, $options: "i" } },
        { caption: { $regex: query, $options: "i" } },
        { tags: { $elemMatch: { $regex: query, $options: "i" } } }
      ];
    }
    if (category) {
      filter.category = category;
    }

    const assets = await MediaAsset.find(filter).sort({ updatedAt: -1 }).lean();
    return jsonOk({ assets });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const asset = await MediaAsset.create({ userId, ...payload });
    return jsonOk({ asset }, "Media asset saved");
  } catch (error) {
    return handleRoleError(error);
  }
}
