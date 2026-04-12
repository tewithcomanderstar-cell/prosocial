import { Schema, model, models } from "mongoose";

const accountSchema = new Schema(
  {
    platformId: { type: Schema.Types.ObjectId, ref: "Platform", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    externalAccountId: { type: String, required: true, index: true },
    displayName: { type: String, required: true },
    status: {
      type: String,
      enum: ["connected", "warning", "expired", "disconnected"],
      default: "connected",
      index: true
    },
    metadataJson: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

accountSchema.index({ platformId: 1, userId: 1, externalAccountId: 1 }, { unique: true });

export const Account = models.Account || model("Account", accountSchema);
