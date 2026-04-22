import { jsonError, jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { runTrendRssPipeline } from "@/lib/services/trend-rss/pipeline";

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const result = await runTrendRssPipeline({ userId, source: "manual", force: true });
    return jsonOk({ result }, "สแกนกระแสข่าวเรียบร้อยแล้ว");
  } catch (error) {
    return handleRoleError(error) ?? jsonError("ไม่สามารถรันโหมดจับกระแสข่าวได้", 500);
  }
}
