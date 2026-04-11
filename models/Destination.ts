import { Schema, model, models } from "mongoose";

const destinationSchema = new Schema(
  {
    platformId: { type: Schema.Types.ObjectId, ref: "Platform", required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    externalDestinationId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ["page", "group", "profile", "channel", "board"],
      default: "page",
      index: true
    },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ["connected", "warning", "expired", "disconnected"],
      default: "connected",
      index: true
    },
    permissionsJson: { type: Schema.Types.Mixed, default: {} },
    healthJson: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

destinationSchema.index({ platformId: 1, accountId: 1, externalDestinationId: 1 }, { unique: true });

export const Destination = models.Destination || model("Destination", destinationSchema);
