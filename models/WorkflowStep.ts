import { Schema, model, models } from "mongoose";

const workflowStepSchema = new Schema(
  {
    workflowId: { type: Schema.Types.ObjectId, ref: "Workflow", required: true, index: true },
    stepOrder: { type: Number, required: true },
    stepType: {
      type: String,
      enum: [
        "create_content_item",
        "generate_caption",
        "rewrite_caption",
        "attach_hashtags",
        "validate_content",
        "submit_for_approval",
        "publish_to_destination",
        "notify_team",
        "retry_later",
        "archive_content_item"
      ],
      required: true,
      index: true
    },
    configJson: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

workflowStepSchema.index({ workflowId: 1, stepOrder: 1 }, { unique: true });

export const WorkflowStep = models.WorkflowStep || model("WorkflowStep", workflowStepSchema);
