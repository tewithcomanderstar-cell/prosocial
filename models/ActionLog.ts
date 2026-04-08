import { Schema, model, models } from "mongoose";

const actionLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["post", "comment", "error", "queue", "settings", "auth", "backup", "token", "analytics"],
      required: true,
      index: true
    },
    level: {
      type: String,
      enum: ["info", "success", "warn", "error"],
      default: "info",
      index: true
    },
    message: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    relatedJobId: { type: Schema.Types.ObjectId, ref: "Job", index: true },
    relatedPostId: { type: Schema.Types.ObjectId, ref: "Post", index: true },
    relatedScheduleId: { type: Schema.Types.ObjectId, ref: "Schedule", index: true }
  },
  { timestamps: true }
);

export const ActionLog = models.ActionLog || model("ActionLog", actionLogSchema);
