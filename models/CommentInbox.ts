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
      enum: ["pending", "matched", "queued", "replying", "replied", "failed", "ignored"],
      default: "pending",
      index: true
    },
    replyText: { type: String },
    repliedAt: { type: Date },
    matchedTrigger: { type: String },
    matchedRuleId: { type: String, index: true },
    matchedRuleType: { type: String },
    autoReplyEnabled: { type: Boolean, default: false },
    replyAttempts: { type: Number, default: 0 },
    replyError: { type: String, default: null },
    replyExternalId: { type: String, default: null },
    queuedAt: { type: Date },
    lastAttemptAt: { type: Date }
  },
  { timestamps: true }
);

export const CommentInbox = models.CommentInbox || model("CommentInbox", commentInboxSchema);
