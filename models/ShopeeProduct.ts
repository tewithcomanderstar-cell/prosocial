import { Schema, model, models } from "mongoose";

const shopeeProductSchema = new Schema(
  {
    productId: { type: String, required: true, unique: true, index: true },
    shopId: { type: String, required: true, index: true },
    itemId: { type: String, required: true, index: true },
    productName: { type: String, required: true, index: "text" },
    productDescription: { type: String, default: "" },
    productPrice: { type: Number, default: 0 },
    discountPrice: { type: Number, default: null },
    discountPercent: { type: Number, default: null, index: true },
    productImageUrl: { type: String, default: "" },
    productUrl: { type: String, default: "" },
    affiliateUrl: { type: String, default: "" },
    category: { type: String, default: "General", index: true },
    salesCount: { type: Number, default: 0, index: true },
    rating: { type: Number, default: 0, index: true },
    commissionRate: { type: Number, default: 0, index: true },
    sourceTag: {
      type: String,
      enum: ["trending", "best_selling", "top_search", "best_roi", "manual"],
      default: "trending",
      index: true
    },
    fetchedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

shopeeProductSchema.index({ category: 1, sourceTag: 1, salesCount: -1, rating: -1 });
shopeeProductSchema.index({ productName: "text", productDescription: "text", category: "text" });

export const ShopeeProduct = models.ShopeeProduct || model("ShopeeProduct", shopeeProductSchema);
