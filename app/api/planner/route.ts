import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getPlannerView } from "@/lib/services/planner";
import { resolveUserLocale } from "@/lib/services/localization";

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const url = new URL(request.url);
    const view = (url.searchParams.get("view") as "day" | "week" | "month" | null) ?? "week";
    const localeConfig = await resolveUserLocale(userId);
    const data = await getPlannerView(userId, view, localeConfig.timezone, localeConfig.locale);
    return jsonOk(data);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load planner");
  }
}
