import { Schema, model, models } from "mongoose";

const googleDriveConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String },
    expiresAt: { type: Date },
    tokenStatus: {
      type: String,
      enum: ["healthy", "warning", "expired", "unknown"],
      default: "unknown"
    },
    lastValidatedAt: { type: Date },
    connectedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const GoogleDriveConnection =
  models.GoogleDriveConnection || model("GoogleDriveConnection", googleDriveConnectionSchema);
