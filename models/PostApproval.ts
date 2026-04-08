import { Schema, model, models } from "mongoose";

const postApprovalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    requestedByUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    assignedToUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    note: { type: String }
  },
  { timestamps: true }
);

export const PostApproval = models.PostApproval || model("PostApproval", postApprovalSchema);
