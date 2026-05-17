import { Schema, model, models } from "mongoose";

const aiGeneratedImageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: String, required: true, index: true },
    prompt: { type: String, required: true },
    generatedImageUrl: { type: String, default: "" },
    fallbackImageUrl: { type: String, default: "" },
    provider: { type: String, default: "fallback_product_image" },
    status: {
      type: String,
      enum: ["pending", "generating", "generated", "failed", "skipped"],
      default: "pending",
      index: true
    },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    promptHistory: { type: [String], default: [] }
  },
  { timestamps: true }
);

aiGeneratedImageSchema.index({ userId: 1, productId: 1, createdAt: -1 });

export const AiGeneratedImage = models.AiGeneratedImage || model("AiGeneratedImage", aiGeneratedImageSchema);
