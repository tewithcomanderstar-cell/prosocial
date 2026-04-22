import { z } from "zod";
import { jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { TrendTrackedPage } from "@/models/TrendTrackedPage";

const schema = z.object({
  pageId: z.string().min(1),
  pageName: z.string().min(1),
  category: z.string().optional().default(""),
  priorityWeight: z.coerce.number().min(0).max(10).default(1),
  trustWeight: z.coerce.number().min(0).max(10).default(1),
  active: z.boolean().default(true)
});

export async function GET() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const pages = await TrendTrackedPage.find({ userId }).sort({ createdAt: -1 }).lean();
    return jsonOk({ pages });
  } catch (error) {
    return handleRoleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const page = await TrendTrackedPage.findOneAndUpdate(
      { userId, pageId: payload.pageId },
      { userId, ...payload },
      { upsert: true, new: true }
    ).lean();
    return jsonOk({ page }, "เพิ่มเพจต้นทางสำหรับจับกระแสแล้ว");
  } catch (error) {
    return handleRoleError(error);
  }
}
