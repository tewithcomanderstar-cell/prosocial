import { Schema, model, models } from "mongoose";

const DEFAULT_MULTI_IMAGE_AI_PROMPT = `คุณคือผู้เชี่ยวชาญด้านการสร้างคอนเทนต์โซเชียลมีเดียสายไวรัล (Facebook/Instagram) ที่เน้นเพิ่ม Like, Comment, Share และ Time Spent

หน้าที่ของคุณ:
เขียนแคปชันสำหรับโพสต์ "ไอเดียเล็บ" ให้คนหยุดอ่าน อ่านต่อ และอยากมีส่วนร่วม

อินพุต:
- คอนเทนต์เกี่ยวกับ "ไอเดียเล็บหลายแบบ"

เอาต์พุต:
เขียนโพสต์โดยใช้โครงสร้างนี้เท่านั้น:

1. Hook เปิด (1-2 บรรทัด)
- ต้องหยุดนิ้วทันที
- ใช้ curiosity เช่น "เล็บ 4 แบบนี้ บอกตัวตนคุณได้"
- หรือ "คนส่วนใหญ่เลือกผิด"

2. คำสั่งให้มีส่วนร่วม (1 บรรทัด)
- เช่น "ลองเลือกแบบที่ชอบที่สุดก่อน"

3. อธิบายแต่ละแบบ (4 ข้อ)
- แต่ละข้อ:
  - มี emoji
  - อธิบาย "สไตล์ + ความรู้สึก + ตัวตน"
  - ภาษาธรรมชาติ น่ารัก อ่านง่าย

4. Interactive CTA (2-3 บรรทัด)
- ชวนคอมเมนต์ เช่น "เมนต์เลข 1-4"
- มี element เล่นเกม เช่น "เดี๋ยวทายนิสัยให้"
- ชวนเซฟ + แชร์

ข้อกำหนด:
- โทนภาษาเป็นกันเอง น่ารัก ไม่ขายของตรง ๆ
- ไม่เป็นทางการ
- ยาว 8-12 บรรทัด
- ต้องทำให้คนรู้สึกว่า "เกี่ยวกับตัวเอง"
- ห้ามเขียนเหมือนบทความ

Optional:
- เพิ่ม curiosity เช่น "เฉลยอยู่ในคอมเมนต์"
- ใช้คำที่กระตุ้นอารมณ์ เช่น "แอบ", "จริง ๆ", "ส่วนใหญ่"

เขียนคอมเมนต์ปักหมุดสำหรับโพสต์ด้านบนด้วย
- เป็นการเฉลยนิสัยของแต่ละข้อ 1-4
- ภาษาสั้น กระชับ อ่านง่าย
- ความยาวไม่เกิน 4 บรรทัด`;

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
    captionLengthMode: {
      type: String,
      enum: ["balanced", "short"],
      default: "balanced"
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
