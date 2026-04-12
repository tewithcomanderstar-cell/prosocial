import { jsonError } from "@/lib/api";

export async function POST() {
  return jsonError("External callbacks are disabled. Automation now runs inside this app.", 410);
}
