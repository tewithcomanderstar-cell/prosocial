import { Schema, model, models } from "mongoose";

const facebookPostQueueSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pageId: { type: String, required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    productId: { type: String, required: true, index: true },
    affiliateLink: { type: String, required: true },
    aiGeneratedPostId: { type: Schema.Types.ObjectId, ref: "AiGeneratedPost" },
    scheduledAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["draft", "generated", "image_ready", "queued", "scheduled", "publishing", "published", "failed", "cancelled"],
      default: "queued",
      index: true
    },
    publishResult: { type: Schema.Types.Mixed, default: {} },
    failureReason: { type: String, default: null },
    errorCode: { type: String, default: null }
  },
  { timestamps: true }
);

facebookPostQueueSchema.index({ userId: 1, pageId: 1, scheduledAt: 1 });
facebookPostQueueSchema.index({ userId: 1, pageId: 1, productId: 1, status: 1 });

export const FacebookPostQueue = models.FacebookPostQueue || model("FacebookPostQueue", facebookPostQueueSchema);
