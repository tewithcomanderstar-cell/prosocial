import { Schema, model, models } from "mongoose";

const productPostHistorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pageId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    shopId: { type: String, default: "", index: true },
    itemId: { type: String, default: "", index: true },
    productUrl: { type: String, default: "" },
    canonicalProductKey: { type: String, default: "", index: true },
    productName: { type: String, default: "" },
    category: { type: String, default: "", index: true },
    productSource: { type: String, default: "shopee-affiliate", index: true },
    templatePostId: { type: String, default: "", index: true },
    postedDate: { type: String, default: "", index: true },
    jobId: { type: String, default: "", index: true },
    pageIds: { type: [String], default: [] },
    postId: { type: Schema.Types.ObjectId, ref: "Post", index: true },
    affiliateLink: { type: String, default: "" },
    shortLink: { type: String, default: "" },
    postedAt: { type: Date, default: Date.now, index: true },
    status: {
      type: String,
      enum: ["queued", "published", "failed", "skipped"],
      default: "queued",
      index: true
    },
    source: { type: String, default: "shopee-affiliate", index: true }
  },
  { timestamps: true }
);

productPostHistorySchema.index({ userId: 1, pageId: 1, productId: 1, postedAt: -1 });
productPostHistorySchema.index({ userId: 1, productId: 1, postedDate: 1, source: 1 });
productPostHistorySchema.index({ userId: 1, shopId: 1, itemId: 1, postedDate: 1, source: 1 });
productPostHistorySchema.index({ userId: 1, canonicalProductKey: 1, postedAt: -1 });

export const ProductPostHistory = models.ProductPostHistory || model("ProductPostHistory", productPostHistorySchema);
