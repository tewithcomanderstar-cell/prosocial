import { Schema, model, models } from "mongoose";

const postMetricSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    scheduleId: { type: Schema.Types.ObjectId, ref: "Schedule", index: true },
    pageId: { type: String, index: true },
    externalPostId: { type: String },
    publishedAt: { type: Date, default: Date.now, index: true },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    engagementScore: { type: Number, default: 0 },
    source: {
      type: String,
      enum: ["sync", "manual", "estimated"],
      default: "estimated"
    }
  },
  { timestamps: true }
);

export const PostMetric = models.PostMetric || model("PostMetric", postMetricSchema);
