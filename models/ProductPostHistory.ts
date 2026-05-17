import { Schema, model, models } from "mongoose";

const productPostHistorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pageId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: "Post", index: true },
    affiliateLink: { type: String, default: "" },
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

export const ProductPostHistory = models.ProductPostHistory || model("ProductPostHistory", productPostHistorySchema);
