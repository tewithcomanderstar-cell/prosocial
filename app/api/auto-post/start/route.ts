import { jsonError, jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { AutoPostConfig } from "@/models/AutoPostConfig";

type LeanAutoPostConfig = {
  _id: string;
  userId: string;
  enabled: boolean;
  folderId: string;
  folderName: string;
  targetPageIds: string[];
  intervalHours: number;
  minRandomDelayMinutes: number;
  maxRandomDelayMinutes: number;
  maxPostsPerDay: number;
  maxPostsPerPagePerDay: number;
  captionStrategy: "manual" | "ai" | "hybrid";
  captions: string[];
  aiPrompt: string;
  language: "th" | "en";
  autoPostStatus?: string;
};

function getNextAutoRun(intervalHours: number) {
  const hours = Math.max(1, intervalHours || 1);
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const config = (await AutoPostConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;

    if (!config) {
      return jsonError("Auto Post settings not found", 404);
    }

    if (!config.folderId) {
      return jsonError("Select a Google Drive folder first", 400);
    }

    if (!config.targetPageIds.length) {
      return jsonError("Select at least one Facebook page first", 400);
    }

    if (["running", "posting", "retrying"].includes(config.autoPostStatus ?? "")) {
      return jsonError("Auto Post is already running", 409);
    }

    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    const webhookSecret = process.env.N8N_SECRET;

    if (!webhookUrl || !webhookSecret) {
      await AutoPostConfig.findByIdAndUpdate(config._id, {
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastError: "n8n webhook is not configured"
      });
      return jsonError("n8n webhook is not configured", 500);
    }

    await AutoPostConfig.findByIdAndUpdate(config._id, {
      enabled: true,
      autoPostStatus: "running",
      jobStatus: "pending",
      lastError: null,
      retryCount: 0,
      lastRunAt: new Date()
    });

    const payload = {
      action: "start",
      userId,
      configId: config._id,
      folderId: config.folderId,
      folderName: config.folderName,
      pageIds: config.targetPageIds,
      intervalHours: config.intervalHours,
      minRandomDelayMinutes: config.minRandomDelayMinutes,
      maxRandomDelayMinutes: config.maxRandomDelayMinutes,
      maxPostsPerDay: config.maxPostsPerDay,
      maxPostsPerPagePerDay: config.maxPostsPerPagePerDay,
      captionStrategy: config.captionStrategy,
      captions: config.captions,
      aiPrompt: config.aiPrompt,
      language: config.language,
      triggeredAt: new Date().toISOString(),
      source: "manual-start"
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": webhookSecret
      },
      body: JSON.stringify(payload),
      cache: "no-store"
    });

    if (!response.ok) {
      const body = await response.text();
      await AutoPostConfig.findByIdAndUpdate(config._id, {
        autoPostStatus: "failed",
        jobStatus: "failed",
        lastError: body || `n8n webhook failed with ${response.status}`
      });
      return jsonError(body || "Unable to trigger n8n workflow", response.status);
    }

    await AutoPostConfig.findByIdAndUpdate(config._id, {
      autoPostStatus: "waiting",
      jobStatus: "pending",
      nextRunAt: getNextAutoRun(config.intervalHours),
      lastError: null
    });

    await logAction({
      userId,
      type: "queue",
      level: "success",
      message: "Auto Post triggered via Start Now",
      metadata: {
        autoPost: true,
        autoPostConfigId: config._id,
        folderId: config.folderId,
        targetPageCount: config.targetPageIds.length,
        intervalHours: config.intervalHours,
        source: "manual-start",
        destination: "n8n",
        action: "start"
      }
    });

    return jsonOk({ started: true }, "Auto Post triggered successfully");
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") {
      return handleRoleError(error);
    }

    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("Unauthorized", 401);
    }

    try {
      const { requireAuth } = await import("@/lib/api");
      const userId = await requireAuth();
      await logAndNotifyError({
        userId,
        message: error instanceof Error ? error.message : "Unable to trigger Auto Post",
        metadata: { autoPost: true, source: "manual-start", destination: "n8n", action: "start" },
        error
      });
    } catch {
      return jsonError("Unauthorized", 401);
    }

    return jsonError(error instanceof Error ? error.message : "Unable to trigger Auto Post", 500);
  }
}
