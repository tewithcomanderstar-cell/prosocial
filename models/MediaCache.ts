import { Schema, model, models } from "mongoose";

const mediaCacheSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    fileId: { type: String, required: true, index: true },
    mimeType: { type: String, required: true },
    fileName: { type: String, required: true },
    bytesBase64: { type: String, required: true },
    source: { type: String, default: "google-drive" },
    expiresAt: { type: Date, index: true }
  },
  { timestamps: true }
);

mediaCacheSchema.index({ userId: 1, fileId: 1 }, { unique: true });

export const MediaCache = models.MediaCache || model("MediaCache", mediaCacheSchema);
