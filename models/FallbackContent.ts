import { Schema, model, models } from "mongoose";

const fallbackContentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    label: { type: String, required: true },
    keyword: { type: String, required: true, index: true },
    caption: { type: String, required: true },
    hashtags: { type: [String], default: [] },
    priority: { type: Number, default: 1 }
  },
  { timestamps: true }
);

export const FallbackContent = models.FallbackContent || model("FallbackContent", fallbackContentSchema);
