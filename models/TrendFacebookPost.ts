import { Schema, model, models } from "mongoose";

const trendFacebookPostSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pageId: { type: String, required: true, index: true },
    externalPostId: { type: String, required: true },
    message: { type: String, default: "" },
    createdAtExternal: { type: Date, default: null },
    reactionsCount: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },
    sharesCount: { type: Number, default: 0 },
    mediaUrls: { type: [String], default: [] },
    rawPayload: { type: Schema.Types.Mixed, default: {} },
    fetchedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

trendFacebookPostSchema.index({ userId: 1, pageId: 1, externalPostId: 1 }, { unique: true });

export const TrendFacebookPost =
  models.TrendFacebookPost || model("TrendFacebookPost", trendFacebookPostSchema);
