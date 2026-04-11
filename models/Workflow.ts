import { Schema, model, models } from "mongoose";

const workflowSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", index: true },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ["draft", "active", "paused", "disabled"],
      default: "draft",
      index: true
    },
    triggerType: {
      type: String,
      enum: ["manual", "schedule", "google_drive_file", "google_sheets_row", "webhook", "retry_failed_publish"],
      default: "manual",
      index: true
    },
    configJson: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }
  },
  { timestamps: true }
);

export const Workflow = models.Workflow || model("Workflow", workflowSchema);
