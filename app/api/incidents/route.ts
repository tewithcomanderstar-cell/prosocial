import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { listIncidents } from "@/lib/services/incidents";

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const url = new URL(request.url);
    const severity = url.searchParams.get("severity") || undefined;
    const source = url.searchParams.get("source") || undefined;
    const limitValue = Number(url.searchParams.get("limit") || "100");
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 200) : 100;
    const incidents = await listIncidents(userId, { severity, source, limit });
    return jsonOk({ incidents });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load incidents", 400);
  }
}
