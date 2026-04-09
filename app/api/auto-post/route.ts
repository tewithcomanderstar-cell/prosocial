import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction } from "@/lib/services/logging";
import { AutoPostConfig } from "@/models/AutoPostConfig";

type LeanAutoPostConfig = {
  enabled?: boolean;
  nextRunAt?: Date;
  lastStatus?: "pending" | "posted" | "failed" | "paused";
  lastError?: string | null;
};

const schema = z.object({
  enabled: z.boolean(),
  folderId: z.string().min(1).default("root"),
  folderName: z.string().min(1).default("My Drive"),
  targetPageIds: z.array(z.string()).default([]),
  intervalHours: z.number().min(1).max(24),
  minRandomDelayMinutes: z.number().min(0).max(720),
  maxRandomDelayMinutes: z.number().min(0).max(1440),
  maxPostsPerDay: z.number().min(1).max(200),
  maxPostsPerPagePerDay: z.number().min(1).max(100),
  captionStrategy: z.enum(["manual", "ai", "hybrid"]),
  captions: z.array(z.string()).default([]),
  aiPrompt: z.string().default(""),
  language: z.enum(["th", "en"]).default("th")
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const config = await AutoPostConfig.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, nextRunAt: new Date() } },
      { upsert: true, new: true }
    ).lean();

    return jsonOk({ config });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const current = (await AutoPostConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;

    const nextRunAt = payload.enabled
      ? current?.enabled
        ? current.nextRunAt ?? new Date()
        : new Date()
      : current?.nextRunAt ?? new Date();

    const config = await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        ...payload,
        captions: (payload.captions ?? []).map((caption) => caption.trim()).filter(Boolean),
        nextRunAt,
        lastStatus: payload.enabled ? (current?.lastStatus ?? "pending") : "paused",
        lastError: payload.enabled ? current?.lastError ?? null : null
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
        folderId: payload.folderId,
        targetPageCount: (payload.targetPageIds ?? []).length,
        intervalHours: payload.intervalHours,
        captionStrategy: payload.captionStrategy
      }
    });

    return jsonOk({ config }, payload.enabled ? "Auto Post settings saved" : "Auto Post paused");
  } catch (error) {
    return handleRoleError(error);
  }
}


