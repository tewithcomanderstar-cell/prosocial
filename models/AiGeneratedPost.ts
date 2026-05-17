import { Schema, model, models } from "mongoose";

const aiGeneratedPostSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: String, required: true, index: true },
    caption: { type: String, required: true },
    imagePrompt: { type: String, default: "" },
    generatedImageUrl: { type: String, default: "" },
    affiliateLink: { type: String, required: true },
    scheduledAt: { type: Date, index: true },
    pageId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["draft", "generated", "image_ready", "queued", "scheduled", "publishing", "published", "failed", "cancelled"],
      default: "draft",
      index: true
    },
    generationMetaJson: { type: Schema.Types.Mixed, default: {} },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null }
  },
  { timestamps: true }
);

aiGeneratedPostSchema.index({ userId: 1, pageId: 1, productId: 1, createdAt: -1 });

export const AiGeneratedPost = models.AiGeneratedPost || model("AiGeneratedPost", aiGeneratedPostSchema);
