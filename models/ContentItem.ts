import { Schema, model, models } from "mongoose";

const contentItemSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    bodyText: { type: String, default: "" },
    mode: { type: String, default: "standard", index: true },
    status: {
      type: String,
      enum: ["draft", "pending_review", "approved", "scheduled", "publishing", "published", "failed", "archived"],
      default: "draft",
      index: true
    },
    platformPayloadJson: { type: Schema.Types.Mixed, default: {} },
    sourceTraceJson: { type: Schema.Types.Mixed, default: {} },
    factSheetJson: { type: Schema.Types.Mixed, default: {} },
    reviewScoresJson: { type: Schema.Types.Mixed, default: {} },
    imagePayloadJson: { type: Schema.Types.Mixed, default: {} },
    generationMetaJson: { type: Schema.Types.Mixed, default: {} },
    destinationIds: { type: [String], default: [] },
    mediaAssetIds: { type: [String], default: [] },
    approvalRequired: { type: Boolean, default: false },
    scheduledAt: { type: Date, index: true },
    publishedAt: { type: Date }
  },
  { timestamps: true }
);

export const ContentItem = models.ContentItem || model("ContentItem", contentItemSchema);
