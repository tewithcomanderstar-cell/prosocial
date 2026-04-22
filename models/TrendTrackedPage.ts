import { Schema, model, models } from "mongoose";

const trendTrackedPageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pageId: { type: String, required: true },
    pageName: { type: String, required: true },
    priorityWeight: { type: Number, default: 1 },
    trustWeight: { type: Number, default: 1 },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

trendTrackedPageSchema.index({ userId: 1, pageId: 1 }, { unique: true });

export const TrendTrackedPage =
  models.TrendTrackedPage || model("TrendTrackedPage", trendTrackedPageSchema);
