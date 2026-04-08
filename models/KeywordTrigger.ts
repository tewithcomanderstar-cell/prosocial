import { Schema, model, models } from "mongoose";

const keywordTriggerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    keyword: { type: String, required: true, index: true },
    triggerType: {
      type: String,
      enum: ["post", "comment"],
      required: true,
      index: true
    },
    action: { type: String, required: true },
    replyText: { type: String },
    enabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export const KeywordTrigger = models.KeywordTrigger || model("KeywordTrigger", keywordTriggerSchema);
