import { Schema, model, models } from "mongoose";

const autoPostConfigSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    folderId: { type: String, default: "root" },
    folderName: { type: String, default: "My Drive" },
    targetPageIds: { type: [String], default: [] },
    intervalMinutes: {
      type: Number,
      enum: [15, 30, 60, 120],
      default: 60
    },
    minRandomDelayMinutes: { type: Number, default: 5 },
    maxRandomDelayMinutes: { type: Number, default: 30 },
    maxPostsPerDay: { type: Number, default: 12 },
    maxPostsPerPagePerDay: { type: Number, default: 4 },
    captionStrategy: {
      type: String,
      enum: ["manual", "ai", "hybrid"],
      default: "hybrid"
    },
    captions: { type: [String], default: [] },
    aiPrompt: { type: String, default: "" },
    language: {
      type: String,
      enum: ["th", "en"],
      default: "th"
    },
    autoPostStatus: {
      type: String,
      enum: ["idle", "running", "posting", "success", "failed", "retrying", "paused", "waiting"],
      default: "paused",
      index: true
    },
    jobStatus: {
      type: String,
      enum: ["pending", "processing", "posted", "failed"],
      default: "pending"
    },
    nextRunAt: { type: Date, default: Date.now, index: true },
    lastRunAt: { type: Date },
    retryCount: { type: Number, default: 0 },
    lastStatus: {
      type: String,
      enum: ["pending", "posted", "failed", "paused"],
      default: "paused"
    },
    lastError: { type: String, default: null },
    lastPostId: { type: Schema.Types.ObjectId, ref: "Post" },
    lastSelectedImageId: { type: String, default: null },
    lastWorkflowId: { type: Schema.Types.ObjectId, ref: "Workflow" },
    lastWorkflowRunId: { type: Schema.Types.ObjectId, ref: "WorkflowRun" },
    lastContentItemId: { type: Schema.Types.ObjectId, ref: "ContentItem" }
  },
  { timestamps: true }
);

export const AutoPostConfig =
  models.AutoPostConfig || model("AutoPostConfig", autoPostConfigSchema);
