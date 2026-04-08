import { Schema, model, models } from "mongoose";

const scheduleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    frequency: {
      type: String,
      enum: ["once", "hourly", "daily", "weekly"],
      default: "once"
    },
    intervalHours: { type: Number, default: 1 },
    delayMinutes: { type: Number, default: 0 },
    runAt: { type: Date, required: true },
    nextRunAt: { type: Date, required: true, index: true },
    enabled: { type: Boolean, default: true },
    lastRunAt: { type: Date },
    timezone: { type: String, default: "Asia/Bangkok" }
  },
  { timestamps: true }
);

export const Schedule = models.Schedule || model("Schedule", scheduleSchema);
