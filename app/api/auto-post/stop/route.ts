import { jsonError, jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction } from "@/lib/services/logging";
import { updateAutoPostRecords } from "@/lib/services/automation-records";
import { AutoPostConfig } from "@/models/AutoPostConfig";

type LeanAutoPostConfig = {
  _id: unknown;
  folderId: string;
  targetPageIds: string[];
};

export async function POST() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const config = (await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        enabled: false,
        autoPostStatus: "idle",
        jobStatus: "pending",
        retryCount: 0,
        lastError: null,
        nextRunAt: null
      },
      { new: true }
    ).lean()) as LeanAutoPostConfig | null;

    if (!config) {
      return jsonError("Auto Post settings not found", 404);
    }

    await updateAutoPostRecords({
      configId: String(config._id),
      autoPostStatus: "idle",
      currentJobStatus: "pending",
      message: "Auto post stopped"
    });

    await logAction({
      userId,
      type: "settings",
      level: "warn",
      message: "Auto Post stopped from control panel",
      metadata: { autoPost: true, autoPostConfigId: String(config._id), action: "stop", source: "control-panel" }
    });

    return jsonOk({ config }, "Auto Post stopped");
  } catch (error) {
    return handleRoleError(error);
  }
}
