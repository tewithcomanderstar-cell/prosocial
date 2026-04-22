import { Schema, model, models } from "mongoose";

const trendFacebookPostSnapshotSchema = new Schema(
  {
    trendFacebookPostId: { type: Schema.Types.ObjectId, ref: "TrendFacebookPost", required: true, index: true },
    reactionsCount: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },
    sharesCount: { type: Number, default: 0 },
    snapshotAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

export const TrendFacebookPostSnapshot =
  models.TrendFacebookPostSnapshot || model("TrendFacebookPostSnapshot", trendFacebookPostSnapshotSchema);
