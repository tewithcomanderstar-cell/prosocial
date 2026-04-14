import { z } from "zod";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction } from "@/lib/services/logging";
import { AutoPostConfig } from "@/models/AutoPostConfig";

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
  captionStrategy: z.enum(["manual", "ai", "hybrid"]),
  captions: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
  aiPrompt: z.string().default(""),
  postingWindowStart: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  postingWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).default("22:00"),
  language: z.enum(["th", "en"]).default("th")
});

export async function GET() {
  try {
    const { requireAuth } = await import("@/lib/api");
    const userId = await requireAuth();
    const config = (await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          nextRunAt: new Date(),
          autoPostStatus: "paused",
          jobStatus: "pending",
          retryCount: 0,
          intervalMinutes: 60
        }
      },
      { upsert: true, new: true }
    ).lean()) as LeanAutoPostConfig | null;

    if (config?.folderId === BROKEN_FOLDER_ID) {
      await AutoPostConfig.findOneAndUpdate({ userId }, { folderId: FIXED_FOLDER_ID });
      config.folderId = FIXED_FOLDER_ID;
    }

    if (config?.lastError) {
      const sanitizedLastError = sanitizeLegacyMessage(config.lastError);
      if (sanitizedLastError !== config.lastError) {
        await AutoPostConfig.findOneAndUpdate({ userId }, { lastError: sanitizedLastError });
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
    const current = (await AutoPostConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;

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

    const config = await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        ...payload,
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
        postingWindowEnd: payload.postingWindowEnd
      },
      { upsert: true, new: true }
    ).lean();

    await logAction({
      userId,
      type: "settings",
      level: "success",
      message: payload.enabled ? "Auto Post configuration updated" : "Auto Post paused",
      metadata: {
        autoPost: true,
        folderId: normalizedFolderId,
        targetPageCount: (payload.targetPageIds ?? []).length,
        intervalMinutes: payload.intervalMinutes,
        captionStrategy: payload.captionStrategy,
        hashtagCount: (payload.hashtags ?? []).length,
        postingWindowStart: payload.postingWindowStart,
        postingWindowEnd: payload.postingWindowEnd,
        autoPostStatus,
        maxTargetPages: 100,
        imageAssignmentMode: "unique-per-page"
      }
    });

    return jsonOk({ config }, payload.enabled ? "Auto Post settings saved" : "Auto Post paused");
  } catch (error) {
    return handleRoleError(error);
  }
}

