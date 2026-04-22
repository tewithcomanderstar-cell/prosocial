import { Schema, model, models } from "mongoose";

const rssArticleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    rssSourceId: { type: Schema.Types.ObjectId, ref: "RssSource", required: true, index: true },
    title: { type: String, required: true },
    url: { type: String, required: true },
    publishedAt: { type: Date, default: null, index: true },
    summary: { type: String, default: "" },
    fullContent: { type: String, default: "" },
    entities: { type: [String], default: [] },
    fingerprint: { type: String, required: true },
    fetchedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

rssArticleSchema.index({ userId: 1, fingerprint: 1 }, { unique: true });

export const RssArticle = models.RssArticle || model("RssArticle", rssArticleSchema);
