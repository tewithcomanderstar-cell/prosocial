import { Schema, model, models } from "mongoose";

const aiGeneratedImageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: String, required: true, index: true },
    prompt: { type: String, required: true },
    generatedImageUrl: { type: String, default: "" },
    pathname: { type: String, default: "", index: true },
    fallbackImageUrl: { type: String, default: "" },
    fallbackPathname: { type: String, default: "" },
    rawResponseUrl: { type: String, default: "" },
    contentType: { type: String, default: "image/png" },
    sizeBytes: { type: Number, default: 0 },
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

aiGeneratedImageSchema.pre("validate", function preventLargeImagePayloads(next) {
  const generatedImageUrl = String(this.get("generatedImageUrl") ?? "");
  const rawResponseUrl = String(this.get("rawResponseUrl") ?? "");

  if (generatedImageUrl.startsWith("data:image/")) {
    next(new Error("AiGeneratedImage.generatedImageUrl must be a Blob URL/path, not base64 data."));
    return;
  }

  if (rawResponseUrl.length > 0 && !/^https?:\/\//.test(rawResponseUrl)) {
    next(new Error("AiGeneratedImage.rawResponseUrl must be a Blob URL."));
    return;
  }

  next();
});

export const AiGeneratedImage = models.AiGeneratedImage || model("AiGeneratedImage", aiGeneratedImageSchema);
