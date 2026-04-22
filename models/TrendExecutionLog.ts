import { Schema, model, models } from "mongoose";

const trendExecutionLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    topicClusterId: { type: Schema.Types.ObjectId, ref: "TrendTopicCluster", index: true, default: null },
    contentItemId: { type: Schema.Types.ObjectId, ref: "ContentItem", index: true, default: null },
    stage: { type: String, required: true, index: true },
    message: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const TrendExecutionLog =
  models.TrendExecutionLog || model("TrendExecutionLog", trendExecutionLogSchema);
