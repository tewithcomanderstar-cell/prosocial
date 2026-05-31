import { Schema, model, models } from "mongoose";

const affiliateLinkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: String, required: true, index: true },
    shopId: { type: String, default: "", index: true },
    itemId: { type: String, default: "", index: true },
    affiliateUrl: { type: String, required: true },
    originalUrl: { type: String, default: "" },
    sourceUrl: { type: String, default: "" },
    shortUrl: { type: String, default: "", index: true },
    trackingId: { type: String, default: "default", index: true },
    status: {
      type: String,
      enum: ["active", "failed", "disabled", "pending"],
      default: "active",
      index: true
    },
    clickCount: { type: Number, default: 0 },
    lastClickedAt: { type: Date },
    retryCount: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    metadataJson: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

affiliateLinkSchema.index(
  { userId: 1, productId: 1, trackingId: 1 },
  { unique: true }
);

export const AffiliateLink = models.AffiliateLink || model("AffiliateLink", affiliateLinkSchema);
