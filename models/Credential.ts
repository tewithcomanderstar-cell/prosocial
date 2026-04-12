import { Schema, model, models } from "mongoose";

const credentialSchema = new Schema(
  {
    platformId: { type: Schema.Types.ObjectId, ref: "Platform", required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String },
    expiresAt: { type: Date },
    scopesJson: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["connected", "warning", "expired", "disconnected"],
      default: "connected",
      index: true
    },
    lastValidatedAt: { type: Date }
  },
  { timestamps: true }
);

credentialSchema.index({ platformId: 1, accountId: 1 }, { unique: true });

export const Credential = models.Credential || model("Credential", credentialSchema);
