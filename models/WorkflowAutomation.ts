import { Schema, model, models } from "mongoose";

const workflowAutomationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    trigger: { type: String, required: true },
    actions: { type: [String], default: [] },
    enabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export const WorkflowAutomation = models.WorkflowAutomation || model("WorkflowAutomation", workflowAutomationSchema);
