import { Schema, model, models } from "mongoose";

const postingSettingsSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    hourlyPostLimit: { type: Number, default: 10 },
    dailyPostLimit: { type: Number, default: 0 },
    commentHourlyLimit: { type: Number, default: 20 },
    minDelaySeconds: { type: Number, default: 15 },
    maxDelaySeconds: { type: Number, default: 90 },
    duplicateWindowHours: { type: Number, default: 24 },
    autoPostDuplicateWindowHours: { type: Number, default: 0 },
    randomizationLevel: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium"
    },
    autoCommentEnabled: { type: Boolean, default: false },
    pageLimitOverride: { type: Number },
    apiBurstWindowMs: { type: Number, default: 60000 },
    apiBurstMax: { type: Number, default: 20 },
    notifyOnError: { type: Boolean, default: true },
    tokenExpiryWarningHours: { type: Number, default: 72 }
  },
  { timestamps: true }
);

export const PostingSettings =
  models.PostingSettings || model("PostingSettings", postingSettingsSchema);
