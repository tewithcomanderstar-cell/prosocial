import { jsonError, jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction } from "@/lib/services/logging";
import { updateAutoPostAiRecords } from "@/lib/services/automation-records-ai";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";

type LeanAutoPostConfig = {
  _id: unknown;
  folderId: string;
  targetPageIds: string[];
};

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const config = (await AutoPostAiConfig.findOneAndUpdate(
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
      return jsonError("Auto Post AI settings not found", 404);
    }

    await updateAutoPostAiRecords({
      configId: String(config._id),
      autoPostStatus: "paused",
      currentJobStatus: "pending",
      message: "Auto Post AI paused"
    });

    await logAction({
      userId,
      type: "settings",
      level: "success",
      message: "Auto Post AI paused from control panel",
      metadata: { autoPostAi: true, autoPostAiConfigId: String(config._id), action: "pause", source: "control-panel" }
    });

    return jsonOk({ config }, "Auto Post AI paused");
  } catch (error) {
    return handleRoleError(error);
  }
}


