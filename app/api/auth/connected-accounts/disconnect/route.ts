import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { logAction } from "@/lib/services/logging";
import { FacebookConnection } from "@/models/FacebookConnection";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";

const schema = z.object({
  provider: z.enum(["facebook-pages", "google-drive"])
});

export async function POST(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());

    if (payload.provider === "facebook-pages") {
      await FacebookConnection.deleteOne({ userId });
    } else {
      await GoogleDriveConnection.deleteOne({ userId });
    }

    await logAction({
      userId,
      type: "auth",
      level: "warn",
      message: `Disconnected ${payload.provider}`
    });

    return jsonOk({}, "Account disconnected");
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(error.issues[0]?.message || "Invalid account selection", 422);
    }

    return jsonError("Unable to disconnect account", 400);
  }
}
