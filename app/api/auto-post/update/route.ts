import { z } from "zod";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { logAction } from "@/lib/services/logging";

type LeanAutoPostConfig = {
  _id: unknown;
  userId: unknown;
};

const schema = z.object({
  configId: z.string().min(1),
  autoPostStatus: z.enum(["idle", "running", "posting", "success", "failed", "retrying", "paused", "waiting"]).optional(),
  currentJobStatus: z.enum(["pending", "processing", "posted", "failed"]).optional(),
  lastRunAt: z.string().optional(),
  nextRunAt: z.string().optional(),
  lastError: z.string().nullable().optional(),
  retryCount: z.number().min(0).optional(),
  message: z.string().optional(),
  pageId: z.string().optional(),
  source: z.string().optional()
});

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (!process.env.N8N_SECRET || apiKey !== process.env.N8N_SECRET) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const payload = parseBody(schema, await request.json());
    const config = (await AutoPostConfig.findById(payload.configId).lean()) as LeanAutoPostConfig | null;

    if (!config) {
      return jsonError("Auto Post config not found", 404);
    }

    const updates: Record<string, unknown> = {};
    if (payload.autoPostStatus) updates.autoPostStatus = payload.autoPostStatus;
    if (payload.currentJobStatus) updates.jobStatus = payload.currentJobStatus;
    if (payload.lastRunAt) updates.lastRunAt = new Date(payload.lastRunAt);
    if (payload.nextRunAt) updates.nextRunAt = new Date(payload.nextRunAt);
    if (payload.lastError !== undefined) updates.lastError = payload.lastError;
    if (payload.retryCount !== undefined) updates.retryCount = payload.retryCount;
    if (payload.currentJobStatus === "posted") updates.lastStatus = "posted";
    if (payload.currentJobStatus === "failed") updates.lastStatus = "failed";
    if (payload.autoPostStatus === "paused") updates.enabled = false;

    await AutoPostConfig.findByIdAndUpdate(payload.configId, updates);

    await logAction({
      userId: String(config.userId),
      type: "queue",
      level: payload.autoPostStatus === "failed" ? "error" : payload.autoPostStatus === "success" ? "success" : "info",
      message: payload.message || "Auto Post status updated from n8n",
      metadata: {
        autoPost: true,
        autoPostConfigId: payload.configId,
        autoPostStatus: payload.autoPostStatus,
        currentJobStatus: payload.currentJobStatus,
        pageId: payload.pageId,
        source: payload.source || "n8n"
      }
    });

    return jsonOk({ updated: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update Auto Post status", 500);
  }
}
