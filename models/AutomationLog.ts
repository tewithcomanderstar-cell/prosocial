import { Schema, model, models } from "mongoose";

const automationLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    source: { type: String, default: "shopee-affiliate", index: true },
    level: {
      type: String,
      enum: ["info", "success", "warn", "error"],
      default: "info",
      index: true
    },
    message: { type: String, required: true },
    productId: { type: String, index: true },
    pageId: { type: String, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

automationLogSchema.index({ userId: 1, source: 1, createdAt: -1 });

export const AutomationLog = models.AutomationLog || model("AutomationLog", automationLogSchema);
