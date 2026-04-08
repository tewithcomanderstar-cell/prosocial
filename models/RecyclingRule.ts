import { Schema, model, models } from "mongoose";

const recyclingRuleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    minAgeDays: { type: Number, default: 7 },
    minimumEngagementScore: { type: Number, default: 5 },
    active: { type: Boolean, default: true },
    rewriteWithAi: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export const RecyclingRule = models.RecyclingRule || model("RecyclingRule", recyclingRuleSchema);
