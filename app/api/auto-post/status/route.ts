import { jsonError, jsonOk } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { ActionLog } from "@/models/ActionLog";

export async function GET() {
  try {
    const { requireAuth } = await import("@/lib/api");
    const userId = await requireAuth();

    const [config, logs] = await Promise.all([
      AutoPostConfig.findOneAndUpdate(
        { userId },
        {
          $setOnInsert: {
            userId,
            nextRunAt: new Date(),
            autoPostStatus: "paused",
            jobStatus: "pending",
            retryCount: 0
          }
        },
        { upsert: true, new: true }
      ).lean(),
      ActionLog.find({
        userId,
        "metadata.autoPost": true
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean()
    ]);

    const normalizedLogs = logs
      .filter((log) => {
        const message = String(log.message ?? "").toLowerCase();
        const metadata = (log.metadata ?? {}) as Record<string, unknown>;
        const source = String(metadata.source ?? "").toLowerCase();
        const destination = String(metadata.destination ?? "").toLowerCase();

        return !message.includes("n8n") && source !== "n8n" && destination !== "n8n";
      })
      .map((log) => ({
      _id: String(log._id),
      level: log.level,
      message: log.message,
      createdAt: log.createdAt,
      metadata: log.metadata ?? {}
      }));

    return jsonOk({ config, logs: normalizedLogs });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
