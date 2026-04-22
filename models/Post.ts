import { Schema, model, models } from "mongoose";

const postSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    pinnedComment: { type: String, default: "" },
    hashtags: { type: [String], default: [] },
    imageUrls: { type: [String], default: [] },
    targetPageIds: { type: [String], default: [] },
    randomizeImages: { type: Boolean, default: false },
    randomizeCaption: { type: Boolean, default: false },
    postingMode: {
      type: String,
      enum: ["broadcast", "random-page"],
      default: "broadcast"
    },
    variants: {
      type: [
        {
          caption: String,
          hashtags: [String]
        }
      ],
      default: []
    },
    status: {
      type: String,
      enum: ["draft", "scheduled", "published", "failed", "retrying"],
      default: "draft"
    },
    contentHash: { type: String, index: true },
    imageHash: { type: String, index: true },
    fingerprint: { type: String, index: true },
    lastPublishedAt: { type: Date },
    successCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export const Post = models.Post || model("Post", postSchema);
