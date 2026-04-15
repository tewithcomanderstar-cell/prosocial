import { Schema, model, models } from "mongoose";

const commentExecutionLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    commentInboxId: { type: Schema.Types.ObjectId, ref: "CommentInbox", required: true, index: true },
    externalCommentId: { type: String, index: true },
    correlationId: { type: String, index: true },
    stage: {
      type: String,
      enum: [
        "webhook_received",
        "webhook_verified",
        "event_normalized",
        "event_stored",
        "job_enqueued",
        "job_processing",
        "rule_matched",
        "reply_sent",
        "reply_failed",
        "event_ignored"
      ],
      required: true,
      index: true
    },
    message: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: null }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const CommentExecutionLog =
  models.CommentExecutionLog || model("CommentExecutionLog", commentExecutionLogSchema);
