import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { NotificationChannel } from "@/models/NotificationChannel";

const schema = z.object({
  channelType: z.enum(["email", "webhook"]),
  target: z.string().min(3),
  enabled: z.boolean().default(true),
  eventTypes: z.array(z.string()).default(["post-success", "post-failed", "comment-new", "token-warning"])
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const channels = await NotificationChannel.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ channels });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());
    const channel = await NotificationChannel.create({ userId, ...payload });
    return jsonOk({ channel }, "Notification channel saved");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save notification channel");
  }
}
