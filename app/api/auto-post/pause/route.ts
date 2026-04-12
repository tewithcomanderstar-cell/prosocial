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
        autoPostStatus: "paused",
        jobStatus: "pending",
        lastError: null
      },
      { new: true }
    ).lean()) as LeanAutoPostConfig | null;

    if (!config) {
      return jsonError("Auto Post settings not found", 404);
    }

    await updateAutoPostRecords({
      configId: String(config._id),
      autoPostStatus: "paused",
      currentJobStatus: "pending",
      message: "Auto post paused"
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
