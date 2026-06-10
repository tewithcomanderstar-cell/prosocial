import { Schema, model, models } from "mongoose";

const shopeeProductReservationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    canonicalProductKey: { type: String, required: true, index: true },
    jobId: { type: String, default: "", index: true },
    templatePostId: { type: String, default: "", index: true },
    reservedAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

shopeeProductReservationSchema.index({ userId: 1, canonicalProductKey: 1, expiresAt: 1 });
shopeeProductReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ShopeeProductReservation =
  models.ShopeeProductReservation || model("ShopeeProductReservation", shopeeProductReservationSchema);
