import { Schema, model, models } from "mongoose";

const rssSourceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sourceName: { type: String, required: true },
    rssUrl: { type: String, required: true },
    category: { type: String, default: "" },
    trustScore: { type: Number, default: 50 },
    language: { type: String, enum: ["th", "en"], default: "th" },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

rssSourceSchema.index({ userId: 1, rssUrl: 1 }, { unique: true });

export const RssSource = models.RssSource || model("RssSource", rssSourceSchema);
