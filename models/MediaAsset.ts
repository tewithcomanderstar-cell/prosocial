import { Schema, model, models } from "mongoose";

const mediaAssetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    type: { type: String, enum: ["image", "video", "caption"], default: "image", index: true },
    category: { type: String, default: "general", index: true },
    sourceUrl: { type: String },
    driveFileId: { type: String },
    caption: { type: String, default: "" },
    tags: { type: [String], default: [] },
    reuseCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date }
  },
  { timestamps: true }
);

export const MediaAsset = models.MediaAsset || model("MediaAsset", mediaAssetSchema);
