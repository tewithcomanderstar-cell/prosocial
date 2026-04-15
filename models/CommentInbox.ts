import { Schema, model, models } from "mongoose";

const commentInboxSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    correlationId: { type: String, index: true },
    pageId: { type: String, required: true, index: true },
    postId: { type: String, index: true },
    parentCommentId: { type: String, index: true },
    externalCommentId: { type: String, index: true, sparse: true },
    authorName: { type: String, required: true },
    senderId: { type: String, index: true },
    message: { type: String, required: true },
    rawPayload: { type: Schema.Types.Mixed, default: null },
    normalizedType: {
      type: String,
      enum: ["comment_created"],
      default: "comment_created"
    },
    status: {
      type: String,
      enum: ["pending", "matched", "received", "queued", "processing", "replying", "replied", "failed", "ignored"],
      default: "received",
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
    receivedAt: { type: Date, default: Date.now },
    queuedAt: { type: Date },
    lastAttemptAt: { type: Date }
  },
  { timestamps: true }
);

commentInboxSchema.index(
  { pageId: 1, externalCommentId: 1 },
  { unique: true, sparse: true, name: "comment_page_external_unique" }
);

export const CommentInbox = models.CommentInbox || model("CommentInbox", commentInboxSchema);
