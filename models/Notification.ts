import { Schema, model, models } from "mongoose";

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["error", "token", "backup", "rate_limit", "analytics", "system"],
      required: true,
      index: true
    },
    severity: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "info"
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date }
  },
  { timestamps: true }
);

export const Notification = models.Notification || model("Notification", notificationSchema);
