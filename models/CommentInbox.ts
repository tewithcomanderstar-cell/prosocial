import { Schema, model, models } from "mongoose";

const commentInboxSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pageId: { type: String, required: true, index: true },
    externalCommentId: { type: String, index: true },
    authorName: { type: String, required: true },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "replied"],
      default: "pending",
      index: true
    },
    replyText: { type: String },
    repliedAt: { type: Date },
    matchedTrigger: { type: String }
  },
  { timestamps: true }
);

export const CommentInbox = models.CommentInbox || model("CommentInbox", commentInboxSchema);
