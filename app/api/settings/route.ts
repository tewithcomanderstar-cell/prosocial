import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { logAction } from "@/lib/services/logging";
import { PostingSettings } from "@/models/PostingSettings";

const schema = z.object({
  hourlyPostLimit: z.number().min(1).max(500),
  dailyPostLimit: z.number().min(0).max(5000),
  commentHourlyLimit: z.number().min(0).max(1000),
  minDelaySeconds: z.number().min(0).max(3600),
  maxDelaySeconds: z.number().min(0).max(7200),
  duplicateWindowHours: z.number().min(1).max(720),
  randomizationLevel: z.enum(["low", "medium", "high"]),
  autoCommentEnabled: z.boolean(),
  apiBurstWindowMs: z.number().min(1000).max(3600000),
  apiBurstMax: z.number().min(1).max(1000),
  notifyOnError: z.boolean(),
  tokenExpiryWarningHours: z.number().min(1).max(720)
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const settings = await PostingSettings.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId } },
      { upsert: true, new: true }
    ).lean();
    return jsonOk({ settings });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());
    const settings = await PostingSettings.findOneAndUpdate({ userId }, payload, {
      upsert: true,
      new: true
    }).lean();

    await logAction({
      userId,
      type: "settings",
      level: "success",
      message: "Advanced posting settings updated",
      metadata: payload
    });

    return jsonOk({ settings }, "Settings updated");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update settings");
  }
}
