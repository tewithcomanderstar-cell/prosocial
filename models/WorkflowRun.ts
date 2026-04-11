import { Schema, model, models } from "mongoose";

const workflowRunSchema = new Schema(
  {
    workflowId: { type: Schema.Types.ObjectId, ref: "Workflow", index: true },
    contentItemId: { type: Schema.Types.ObjectId, ref: "ContentItem", index: true },
    triggerSource: { type: String, default: "manual", index: true },
    status: {
      type: String,
      enum: ["pending", "running", "succeeded", "failed", "cancelled"],
      default: "pending",
      index: true
    },
    startedAt: { type: Date, default: Date.now, index: true },
    finishedAt: { type: Date },
    errorMessage: { type: String },
    inputJson: { type: Schema.Types.Mixed, default: {} },
    outputJson: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const WorkflowRun = models.WorkflowRun || model("WorkflowRun", workflowRunSchema);
