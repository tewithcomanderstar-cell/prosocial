import { Schema, model, models } from "mongoose";

const affiliateLinkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: String, required: true, index: true },
    affiliateUrl: { type: String, required: true },
    sourceUrl: { type: String, default: "" },
    trackingId: { type: String, default: "default", index: true },
    status: {
      type: String,
      enum: ["active", "failed", "disabled"],
      default: "active",
      index: true
    },
    lastError: { type: String, default: null }
  },
  { timestamps: true }
);

affiliateLinkSchema.index({ userId: 1, productId: 1, trackingId: 1 }, { unique: true });

export const AffiliateLink = models.AffiliateLink || model("AffiliateLink", affiliateLinkSchema);
