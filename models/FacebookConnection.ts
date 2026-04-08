import { Schema, model, models } from "mongoose";

const connectedPageSchema = new Schema(
  {
    pageId: { type: String, required: true },
    name: { type: String, required: true },
    pageAccessToken: { type: String, required: true },
    category: { type: String }
  },
  { _id: false }
);

const facebookConnectionSchema = new Schema(
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
    connectedAt: { type: Date, default: Date.now },
    pages: { type: [connectedPageSchema], default: [] }
  },
  { timestamps: true }
);

export const FacebookConnection =
  models.FacebookConnection || model("FacebookConnection", facebookConnectionSchema);
