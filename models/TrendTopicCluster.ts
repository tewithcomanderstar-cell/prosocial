import { Schema, model, models } from "mongoose";

const trendTopicClusterSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    label: { type: String, required: true },
    summary: { type: String, default: "" },
    emotionType: {
      type: String,
      enum: ["alarm", "hope", "conflict", "human_interest", "neutral"],
      default: "neutral"
    },
    trendScore: { type: Number, default: 0, index: true },
    hotLevel: { type: String, enum: ["warm", "hot", "surging"], default: "warm" },
    status: {
      type: String,
      enum: ["detected", "resolved", "generated", "needs_review", "rejected"],
      default: "detected",
      index: true
    },
    sourcePostIds: { type: [Schema.Types.ObjectId], ref: "TrendFacebookPost", default: [] },
    relatedEntities: { type: [String], default: [] },
    detectedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const TrendTopicCluster =
  models.TrendTopicCluster || model("TrendTopicCluster", trendTopicClusterSchema);
