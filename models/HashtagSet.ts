import { Schema, model, models } from "mongoose";

const hashtagSetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    category: { type: String, default: "general", index: true },
    hashtags: { type: [String], default: [] },
    usageCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export const HashtagSet = models.HashtagSet || model("HashtagSet", hashtagSetSchema);
