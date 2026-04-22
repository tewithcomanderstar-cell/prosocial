import { Schema, model, models } from "mongoose";

const trendArticleResolutionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    topicClusterId: { type: Schema.Types.ObjectId, ref: "TrendTopicCluster", required: true, unique: true },
    primaryArticleId: { type: Schema.Types.ObjectId, ref: "RssArticle", required: true },
    supportingArticleIds: { type: [Schema.Types.ObjectId], ref: "RssArticle", default: [] },
    confidenceScore: { type: Number, default: 0 },
    resolutionNotes: { type: String, default: "" }
  },
  { timestamps: true }
);

export const TrendArticleResolution =
  models.TrendArticleResolution || model("TrendArticleResolution", trendArticleResolutionSchema);
