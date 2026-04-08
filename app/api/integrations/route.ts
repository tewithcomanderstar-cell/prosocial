import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { IntegrationConnection } from "@/models/IntegrationConnection";

const schema = z.object({
  provider: z.enum(["canva", "unsplash", "wordpress", "facebook", "google-drive"]),
  status: z.enum(["connected", "available", "disconnected"]).default("available"),
  metadata: z.record(z.any()).default({})
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const integrations = await IntegrationConnection.find({ userId }).sort({ provider: 1 }).lean();
    return jsonOk({ integrations });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());
    const integration = await IntegrationConnection.findOneAndUpdate(
      { userId, provider: payload.provider },
      { ...payload, userId },
      { upsert: true, new: true }
    ).lean();
    return jsonOk({ integration }, "Integration updated");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update integration");
  }
}
