import { z } from "zod";
import { jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { RssSource } from "@/models/RssSource";

const schema = z.object({
  sourceName: z.string().min(1),
  rssUrl: z.string().url(),
  category: z.string().optional().default(""),
  trustScore: z.coerce.number().min(0).max(100).default(50),
  language: z.enum(["th", "en"]).default("th"),
  active: z.boolean().default(true)
});

export async function GET() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const sources = await RssSource.find({ userId }).sort({ createdAt: -1 }).lean();
    return jsonOk({ sources });
  } catch (error) {
    return handleRoleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const source = await RssSource.findOneAndUpdate(
      { userId, rssUrl: payload.rssUrl },
      { userId, ...payload },
      { upsert: true, new: true }
    ).lean();
    return jsonOk({ source }, "เพิ่มเว็บข่าวสำหรับยืนยันประเด็นแล้ว");
  } catch (error) {
    return handleRoleError(error);
  }
}
