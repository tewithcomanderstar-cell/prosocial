import { Schema, model, models } from "mongoose";

const workspaceSchema = new Schema(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    timezone: { type: String, default: "Asia/Bangkok" },
    locale: { type: String, default: "th-TH" },
    plan: { type: String, enum: ["free", "pro", "business"], default: "free" },
    pageLimit: { type: Number, default: 5 },
    subscriptionStatus: { type: String, enum: ["trialing", "active", "inactive"], default: "trialing" }
  },
  { timestamps: true }
);

export const Workspace = models.Workspace || model("Workspace", workspaceSchema);
