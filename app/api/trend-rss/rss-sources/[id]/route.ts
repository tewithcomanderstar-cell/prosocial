import { z } from "zod";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { RssSource } from "@/models/RssSource";

const patchSchema = z.object({
  sourceName: z.string().min(1).optional(),
  rssUrl: z.string().url().optional(),
  category: z.string().optional(),
  trustScore: z.coerce.number().min(0).max(100).optional(),
  language: z.enum(["th", "en"]).optional(),
  active: z.boolean().optional()
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const { id } = await context.params;
    const payload = parseBody(patchSchema, await request.json());
    const source = await RssSource.findOneAndUpdate({ _id: id, userId }, payload, { new: true }).lean();
    if (!source) {
      return jsonError("ไม่พบเว็บข่าวที่ต้องการแก้ไข", 404);
    }
    return jsonOk({ source }, "อัปเดตเว็บข่าวเรียบร้อยแล้ว");
  } catch (error) {
    return handleRoleError(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const { id } = await context.params;
    await RssSource.findOneAndDelete({ _id: id, userId });
    return jsonOk({ deleted: true }, "ลบเว็บข่าวเรียบร้อยแล้ว");
  } catch (error) {
    return handleRoleError(error);
  }
}
