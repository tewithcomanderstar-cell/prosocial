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
    subId: { type: String, default: "", index: true },
    subId1: { type: String, default: "", index: true },
    subId2: { type: String, default: "", index: true },
    subId3: { type: String, default: "", index: true },
    subId4: { type: String, default: "", index: true },
    subId5: { type: String, default: "", index: true },
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
  { userId: 1, productId: 1, trackingId: 1, subId: 1, subId1: 1, subId2: 1, subId3: 1, subId4: 1, subId5: 1 },
  { unique: true }
);

export const AffiliateLink = models.AffiliateLink || model("AffiliateLink", affiliateLinkSchema);
