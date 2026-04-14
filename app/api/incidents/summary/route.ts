import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { getIncidentSummary } from "@/lib/services/incidents";

export async function GET() {
  try {
    const userId = await requireAuth();
    const summary = await getIncidentSummary(userId);
    return jsonOk(summary);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load incident summary", 400);
  }
}
