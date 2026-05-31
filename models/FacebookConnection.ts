import { Schema, model, models } from "mongoose";

const connectedPageSchema = new Schema(
  {
    pageId: { type: String, required: true },
    name: { type: String, required: true },
    pageAccessToken: { type: String, required: true },
    category: { type: String },
    profilePictureUrl: { type: String, default: null },
    profilePictureFetchedAt: { type: Date, default: null }
  },
  { _id: false }
);

const facebookConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String },
    expiresAt: { type: Date },
    tokenStatus: {
      type: String,
      enum: ["healthy", "warning", "expired", "unknown"],
      default: "unknown"
    },
    lastValidatedAt: { type: Date },
    lastSyncAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    connectedAt: { type: Date, default: Date.now },
    pages: { type: [connectedPageSchema], default: [] }
  },
  { timestamps: true }
);

export const FacebookConnection =
  models.FacebookConnection || model("FacebookConnection", facebookConnectionSchema);
