import { jsonOk } from "@/lib/api";
import { getSetupStatus } from "@/lib/setup-status";

export async function GET() {
  return jsonOk(getSetupStatus());
}
