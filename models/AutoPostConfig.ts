import { Schema, model, models } from "mongoose";

const autoPostConfigSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    contentSource: {
      type: String,
      enum: ["shopee-affiliate", "google-drive"],
      default: "shopee-affiliate",
      index: true
    },
    folderId: { type: String, default: "root" },
    folderName: { type: String, default: "My Drive" },
    shopeeSourceTag: {
      type: String,
      enum: ["trending", "best_selling", "top_search", "best_roi", "manual"],
      default: "trending",
      index: true
    },
    shopeeKeyword: { type: String, default: "" },
    shopeeCategory: { type: String, default: "" },
    shopeeCaptionStyle: {
      type: String,
      enum: ["soft_sell", "urgency", "problem_solution", "review_style", "deal_alert", "lifestyle"],
      default: "soft_sell"
    },
    shopeeTrackingId: { type: String, default: "" },
    shopeeBlockedCategories: { type: [String], default: [] },
    shopeeCategoryPriority: { type: [String], default: [] },
    targetPageIds: { type: [String], default: [] },
    intervalMinutes: {
      type: Number,
      enum: [15, 30, 60, 120],
      default: 60
    },
    minRandomDelayMinutes: { type: Number, default: 5 },
    maxRandomDelayMinutes: { type: Number, default: 30 },
    maxPostsPerDay: { type: Number, default: 0 },
    maxPostsPerPagePerDay: { type: Number, default: 0 },
    captionStrategy: {
      type: String,
      enum: ["manual", "ai", "hybrid"],
      default: "hybrid"
    },
    captions: { type: [String], default: [] },
    hashtags: { type: [String], default: [] },
    aiPrompt: { type: String, default: "" },
    watermarkEnabled: { type: Boolean, default: true },
    watermarkSource: {
      type: String,
      enum: ["page_profile", "custom_logo", "none"],
      default: "page_profile"
    },
    watermarkPosition: {
      type: String,
      enum: ["top-left", "top-right", "bottom-left", "bottom-right"],
      default: "bottom-right"
    },
    watermarkSizePercent: { type: Number, default: 17 },
    postingWindowStart: { type: String, default: "06:00" },
    postingWindowEnd: { type: String, default: "00:00" },
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
    usedImageIds: { type: [String], default: [] },
    dailyImageUsageDate: { type: String, default: null },
    dailyUsedImageIds: { type: [String], default: [] },
    lastWorkflowId: { type: Schema.Types.ObjectId, ref: "Workflow" },
    lastWorkflowRunId: { type: Schema.Types.ObjectId, ref: "WorkflowRun" },
    lastContentItemId: { type: Schema.Types.ObjectId, ref: "ContentItem" }
  },
  { timestamps: true }
);

export const AutoPostConfig =
  models.AutoPostConfig || model("AutoPostConfig", autoPostConfigSchema);
