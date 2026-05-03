import { jsonOk } from "@/lib/api";
import { getOAuthConfigDebug } from "@/lib/services/oauth-debug";

export async function GET(request: Request) {
  return jsonOk(getOAuthConfigDebug(request));
}
