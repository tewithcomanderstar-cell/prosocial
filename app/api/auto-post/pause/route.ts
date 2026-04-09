import { jsonError, jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction } from "@/lib/services/logging";
import { AutoPostConfig } from "@/models/AutoPostConfig";

type LeanAutoPostConfig = {
  _id: unknown;
  folderId: string;
  targetPageIds: string[];
};

async function notifyN8n(action: "pause", payload: Record<string, unknown>) {
  if (!process.env.N8N_WEBHOOK_URL || !process.env.N8N_SECRET) {
    return;
  }

  await fetch(process.env.N8N_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.N8N_SECRET
    },
    body: JSON.stringify({ action, source: "control-panel", ...payload }),
    cache: "no-store"
  }).catch(() => null);
}

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const config = (await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        enabled: false,
        autoPostStatus: "paused",
        jobStatus: "pending",
        lastError: null
      },
      { new: true }
    ).lean()) as LeanAutoPostConfig | null;

    if (!config) {
      return jsonError("Auto Post settings not found", 404);
    }

    await notifyN8n("pause", {
      userId,
      configId: String(config._id),
      folderId: config.folderId,
      pageIds: config.targetPageIds
    });

    await logAction({
      userId,
      type: "settings",
      level: "success",
      message: "Auto Post paused from control panel",
      metadata: { autoPost: true, autoPostConfigId: String(config._id), action: "pause", source: "control-panel" }
    });

    return jsonOk({ config }, "Auto Post paused");
  } catch (error) {
    return handleRoleError(error);
  }
}
