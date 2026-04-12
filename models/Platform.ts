import { Schema, model, models } from "mongoose";

const platformSchema = new Schema(
  {
    key: {
      type: String,
      enum: ["facebook", "instagram", "tiktok", "linkedin", "x", "youtube", "line"],
      required: true,
      unique: true,
      index: true
    },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ["active", "disabled", "beta"],
      default: "active",
      index: true
    }
  },
  { timestamps: true }
);

export const Platform = models.Platform || model("Platform", platformSchema);
