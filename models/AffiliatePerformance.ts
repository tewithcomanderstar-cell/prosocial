import { Schema, model, models } from "mongoose";

const affiliatePerformanceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: String, required: true, index: true },
    pageId: { type: String, required: true, index: true },
    affiliateLink: { type: String, default: "" },
    queuedPosts: { type: Number, default: 0 },
    publishedPosts: { type: Number, default: 0 },
    failedPosts: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    estimatedRevenue: { type: Number, default: 0 },
    metadataJson: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

affiliatePerformanceSchema.index({ userId: 1, productId: 1, pageId: 1 }, { unique: true });

export const AffiliatePerformance =
  models.AffiliatePerformance || model("AffiliatePerformance", affiliatePerformanceSchema);
