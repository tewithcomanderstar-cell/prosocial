import { z } from "zod";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction } from "@/lib/services/logging";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";

const DEFAULT_MULTI_IMAGE_AI_PROMPT = `เขียนแคปชั่น Facebook ภาษาไทยสำหรับโพสต์หลายภาพ ให้เป็นสไตล์คอนเทนต์น่ารัก ละมุน ชวนหยุดดู ชวนเซฟ และชวนคอมเมนต์ เปิดโพสต์ด้วย hook แบบชวนหยุดอ่าน เช่น ยังไม่มีไอเดียใช่มั้ย หรือ หยุดตรงนี้ก่อนเลยน้า จากนั้นสรุปว่าโพสต์นี้รวมไอเดียอะไร แล้วไล่อธิบายทีละรูปเป็น แบบ 1 / แบบ 2 / แบบ 3 ... ให้แต่ละรูปมีฟีลต่างกัน ปิดท้ายด้วย CTA ให้คอมเมนต์ เซฟ และแชร์ โดยต้องอิงจากรายละเอียดในภาพจริง ห้ามเขียนกว้างหรือมั่ว`;

type LeanAutoPostConfig = {
  enabled?: boolean;
  nextRunAt?: Date | null;
  autoPostStatus?: "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
  jobStatus?: "pending" | "processing" | "posted" | "failed";
  lastError?: string | null;
  retryCount?: number;
  folderId?: string;
};

const intervalSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(120)
]);

const BROKEN_FOLDER_ID = "1sbp9Ql8moMDs9xBSha5IWoKdE1WlEEWz";
const FIXED_FOLDER_ID = "1sbp9Ql8moMDs9xBSha5lWoKdE1WiEEWz";

function normalizeFolderId(value: string) {
  const trimmed = value.trim();
  return trimmed === BROKEN_FOLDER_ID ? FIXED_FOLDER_ID : trimmed;
}

function sanitizeLegacyMessage(value?: string | null) {
  if (!value) return value ?? null;

  const normalized = value.toLowerCase();
  if (
    normalized.includes("n8n") ||
    normalized.includes("requested webhook") ||
    normalized.includes("workflow must be active") ||
    normalized.includes("webhook")
  ) {
    return null;
  }

  return value;
}

const schema = z.object({
  enabled: z.boolean(),
  folderId: z.string().min(1).default("root"),
  folderName: z.string().min(1).default("My Drive"),
  targetPageIds: z.array(z.string()).max(100, "Select up to 100 Facebook pages").default([]),
  intervalMinutes: intervalSchema.default(60),
  captionStrategy: z.enum(["manual", "ai", "hybrid"]).default("hybrid"),
  multiImageCountMode: z.enum(["4", "5", "6-10"]).default("4"),
  captionLengthMode: z.enum(["balanced", "short"]).default("balanced"),
  captions: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
  aiPrompt: z.string().default(DEFAULT_MULTI_IMAGE_AI_PROMPT),
  postingWindowStart: z.string().regex(/^\d{2}:\d{2}$/).default("06:00"),
  postingWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
  autoCommentEnabled: z.boolean().default(false),
  autoCommentIntervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(15),
  language: z.enum(["th", "en"]).default("th")
});

export async function GET() {
  try {
    const { requireAuth } = await import("@/lib/api");
    const userId = await requireAuth();
    const config = (await AutoPostAiConfig.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          nextRunAt: new Date(),
          autoPostStatus: "paused",
          jobStatus: "pending",
          retryCount: 0,
          intervalMinutes: 60,
          automationMode: "multi-image-ai",
          multiImageCountMode: "4",
          captionLengthMode: "balanced",
          aiPrompt: DEFAULT_MULTI_IMAGE_AI_PROMPT,
          autoCommentEnabled: false,
          autoCommentIntervalMinutes: 15
        }
      },
      { upsert: true, new: true }
    ).lean()) as LeanAutoPostConfig | null;

    if (config?.folderId === BROKEN_FOLDER_ID) {
      await AutoPostAiConfig.findOneAndUpdate({ userId }, { folderId: FIXED_FOLDER_ID });
      config.folderId = FIXED_FOLDER_ID;
    }

    if (config?.lastError) {
      const sanitizedLastError = sanitizeLegacyMessage(config.lastError);
      if (sanitizedLastError !== config.lastError) {
        await AutoPostAiConfig.findOneAndUpdate({ userId }, { lastError: sanitizedLastError });
        config.lastError = sanitizedLastError;
      }
    }

    return jsonOk({ config });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const normalizedFolderId = normalizeFolderId(payload.folderId ?? "root");
    const current = (await AutoPostAiConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;

    const nextRunAt = payload.enabled
      ? current?.enabled
        ? current.nextRunAt ?? new Date()
        : new Date()
      : current?.nextRunAt ?? new Date();

    const autoPostStatus = payload.enabled
      ? current?.autoPostStatus && current.autoPostStatus !== "paused"
        ? current.autoPostStatus
        : "waiting"
      : "paused";

    const config = await AutoPostAiConfig.findOneAndUpdate(
      { userId },
      {
        ...payload,
        automationMode: "multi-image-ai",
        folderId: normalizedFolderId,
        captions: (payload.captions ?? []).map((caption) => caption.trim()).filter(Boolean),
        hashtags: (payload.hashtags ?? []).map((hashtag) => hashtag.trim()).filter(Boolean),
        nextRunAt,
        autoPostStatus,
        jobStatus: payload.enabled ? current?.jobStatus ?? "pending" : "pending",
        lastStatus: payload.enabled ? (current?.jobStatus === "posted" ? "posted" : current?.lastError ? "failed" : "pending") : "paused",
        lastError: payload.enabled ? sanitizeLegacyMessage(current?.lastError ?? null) : null,
        retryCount: payload.enabled ? current?.retryCount ?? 0 : 0,
        postingWindowStart: payload.postingWindowStart,
        postingWindowEnd: payload.postingWindowEnd,
        autoCommentEnabled: payload.autoCommentEnabled,
        autoCommentIntervalMinutes: payload.autoCommentIntervalMinutes
      },
      { upsert: true, new: true }
    ).lean();

    await logAction({
      userId,
      type: "settings",
      level: "success",
      message: payload.enabled ? "Auto Post AI configuration updated" : "Auto Post AI paused",
      metadata: {
        autoPostAi: true,
        folderId: normalizedFolderId,
        targetPageCount: (payload.targetPageIds ?? []).length,
        intervalMinutes: payload.intervalMinutes,
        multiImageCountMode: payload.multiImageCountMode,
        captionLengthMode: payload.captionLengthMode,
        captionStrategy: payload.captionStrategy,
        autoCommentEnabled: payload.autoCommentEnabled,
        autoCommentIntervalMinutes: payload.autoCommentIntervalMinutes,
        hashtagCount: (payload.hashtags ?? []).length,
        postingWindowStart: payload.postingWindowStart,
        postingWindowEnd: payload.postingWindowEnd,
        autoPostStatus,
        maxTargetPages: 100,
        imageAssignmentMode: "similar-image-cluster"
      }
    });

    return jsonOk({ config }, payload.enabled ? "Auto Post AI settings saved" : "Auto Post AI paused");
  } catch (error) {
    return handleRoleError(error);
  }
}



