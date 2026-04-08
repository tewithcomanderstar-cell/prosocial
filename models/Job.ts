import { Schema, model, models } from "mongoose";

const jobSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["post", "comment-reply"],
      default: "post",
      index: true
    },
    scheduleId: { type: Schema.Types.ObjectId, ref: "Schedule", index: true },
    postId: { type: Schema.Types.ObjectId, ref: "Post", index: true },
    targetPageId: { type: String, index: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    fingerprint: { type: String, index: true },
    status: {
      type: String,
      enum: ["queued", "processing", "success", "failed", "retrying", "rate_limited", "duplicate_blocked"],
      default: "queued",
      index: true
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    nextRunAt: { type: Date, default: Date.now, index: true },
    processingStartedAt: { type: Date },
    completedAt: { type: Date },
    lastError: { type: String },
    result: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const Job = models.Job || model("Job", jobSchema);
