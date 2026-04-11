import { Schema, model, models } from "mongoose";

const approvalRequestSchema = new Schema(
  {
    contentItemId: { type: Schema.Types.ObjectId, ref: "ContentItem", required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", index: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "changes_requested"],
      default: "pending",
      index: true
    },
    comment: { type: String },
    decidedAt: { type: Date }
  },
  { timestamps: true }
);

export const ApprovalRequest = models.ApprovalRequest || model("ApprovalRequest", approvalRequestSchema);
