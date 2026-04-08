import { Schema, model, models } from "mongoose";

const abTestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ["draft", "running", "completed"],
      default: "draft"
    },
    postIds: { type: [Schema.Types.ObjectId], ref: "Post", default: [] },
    testMode: {
      type: String,
      enum: ["different-pages", "different-times"],
      default: "different-times"
    },
    winningPostId: { type: Schema.Types.ObjectId, ref: "Post" },
    resultSummary: { type: String }
  },
  { timestamps: true }
);

export const ABTest = models.ABTest || model("ABTest", abTestSchema);
