import { Schema, model, models } from "mongoose";

const growthAutomationRuleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    triggerKeyword: { type: String, required: true, index: true },
    actionType: {
      type: String,
      enum: ["invite-inbox", "send-link", "custom-reply"],
      required: true
    },
    replyText: { type: String, required: true },
    linkUrl: { type: String },
    enabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export const GrowthAutomationRule =
  models.GrowthAutomationRule || model("GrowthAutomationRule", growthAutomationRuleSchema);
