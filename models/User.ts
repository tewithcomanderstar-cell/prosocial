import { Schema, model, models } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, default: null },
    provider: {
      type: String,
      enum: ["credentials", "google", "facebook"],
      default: "credentials"
    },
    providerId: {
      type: String,
      default: null,
      sparse: true,
      index: true
    },
    avatar: { type: String, default: null },
    role: {
      type: String,
      enum: ["admin", "editor", "viewer"],
      default: "admin"
    },
    timezone: { type: String, default: "Asia/Bangkok" },
    locale: { type: String, default: "th-TH" },
    plan: {
      type: String,
      enum: ["free", "pro", "business"],
      default: "free"
    },
    subscriptionStatus: {
      type: String,
      enum: ["trialing", "active", "inactive"],
      default: "trialing"
    },
    pageLimit: { type: Number, default: 5 }
  },
  { timestamps: true }
);

export const User = models.User || model("User", userSchema);
