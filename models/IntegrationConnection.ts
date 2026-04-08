import { Schema, model, models } from "mongoose";

const integrationConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    provider: { type: String, enum: ["canva", "unsplash", "wordpress", "facebook", "google-drive"], required: true, index: true },
    status: { type: String, enum: ["connected", "available", "disconnected"], default: "available" },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

integrationConnectionSchema.index({ userId: 1, provider: 1 }, { unique: true });

export const IntegrationConnection = models.IntegrationConnection || model("IntegrationConnection", integrationConnectionSchema);
