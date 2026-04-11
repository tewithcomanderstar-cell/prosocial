import { jsonError } from "@/lib/api";

export async function POST() {
  return jsonError("External n8n callbacks are no longer used. Automation now runs inside this app.", 410);
}
