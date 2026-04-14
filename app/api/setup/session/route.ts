import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { buildSetupWizardState, startSetupSession } from "@/lib/services/setup-wizard";

export async function GET() {
  try {
    const userId = await requireAuth();
    const state = await buildSetupWizardState(userId);
    return jsonOk(state);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load setup wizard", 400);
  }
}

export async function POST() {
  try {
    const userId = await requireAuth();
    const state = await startSetupSession(userId);
    return jsonOk(state, "Setup wizard started");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to start setup wizard", 400);
  }
}
