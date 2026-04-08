import { clearSession } from "@/lib/auth";
import { jsonOk } from "@/lib/api";

export async function POST() {
  await clearSession();
  return jsonOk({}, "Logged out");
}
