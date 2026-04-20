import { Schema, model, models } from "mongoose";

const DEFAULT_MULTI_IMAGE_AI_PROMPT = `เขียนแคปชั่น Facebook ภาษาไทยสำหรับโพสต์หลายภาพ ให้เป็นสไตล์คอนเทนต์น่ารัก ละมุน ชวนหยุดดู ชวนเซฟ และชวนคอมเมนต์ เปิดโพสต์ด้วย hook แบบชวนหยุดอ่าน เช่น ยังไม่มีไอเดียใช่มั้ย หรือ หยุดตรงนี้ก่อนเลยน้า จากนั้นสรุปว่าโพสต์นี้รวมไอเดียอะไร แล้วไล่อธิบายทีละรูปเป็น แบบ 1 / แบบ 2 / แบบ 3 ... ให้แต่ละรูปมีฟีลต่างกัน ปิดท้ายด้วย CTA ให้คอมเมนต์ เซฟ และแชร์ โดยต้องอิงจากรายละเอียดในภาพจริง ห้ามเขียนกว้างหรือมั่ว`;

const autoPostAiConfigSchema = new Schema(
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
    maxPostsPerDay: { type: Number, default: 0 },
    maxPostsPerPagePerDay: { type: Number, default: 0 },
    captionStrategy: {
      type: String,
      enum: ["manual", "ai", "hybrid"],
      default: "hybrid"
    },
    automationMode: {
      type: String,
      enum: ["standard", "multi-image-ai"],
      default: "standard"
    },
    multiImageCountMode: {
      type: String,
      enum: ["4", "5", "6-10"],
      default: "4"
    },
    captions: { type: [String], default: [] },
    hashtags: { type: [String], default: [] },
    aiPrompt: { type: String, default: DEFAULT_MULTI_IMAGE_AI_PROMPT },
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
    recentImageUsage: {
      type: [
        {
          imageId: { type: String, required: true },
          usedAt: { type: Date, required: true }
        }
      ],
      default: []
    },
    lastWorkflowId: { type: Schema.Types.ObjectId, ref: "Workflow" },
    lastWorkflowRunId: { type: Schema.Types.ObjectId, ref: "WorkflowRun" },
    lastContentItemId: { type: Schema.Types.ObjectId, ref: "ContentItem" }
  },
  { timestamps: true }
);

export const AutoPostAiConfig =
  models.AutoPostAiConfig || model("AutoPostAiConfig", autoPostAiConfigSchema);
