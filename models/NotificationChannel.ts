import { Schema, model, models } from "mongoose";

const notificationChannelSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    channelType: { type: String, enum: ["email", "webhook"], required: true, index: true },
    target: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    eventTypes: { type: [String], default: ["post-success", "post-failed", "comment-new", "token-warning"] }
  },
  { timestamps: true }
);

export const NotificationChannel = models.NotificationChannel || model("NotificationChannel", notificationChannelSchema);
