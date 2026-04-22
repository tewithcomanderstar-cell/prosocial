import { z } from "zod";
import { jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { TrendRssNewsConfig } from "@/models/TrendRssNewsConfig";

function normalizeInterval(value?: number | null) {
  return value === 30 || value === 60 || value === 120 ? value : 60;
}

type LeanTrendConfig = {
  intervalMinutes?: number | null;
  autoPostIntervalMinutes?: number | null;
  [key: string]: unknown;
} | null;

const configSchema = z.object({
  enabled: z.boolean().default(false),
  autoRunEnabled: z.boolean().default(false),
  intervalMinutes: z.union([z.literal(30), z.literal(60), z.literal(120)]).default(60),
  autoPostEnabled: z.boolean().default(false),
  autoPostIntervalMinutes: z.union([z.literal(30), z.literal(60), z.literal(120)]).default(60),
  destinationPageIds: z.array(z.string()).default([]),
  strategyGoal: z.enum(["maximize_shares", "maximize_time_spend", "maximize_engagement", "maximize_trust"]).default("maximize_time_spend"),
  safeDraftMode: z.boolean().default(true),
  templateId: z.string().nullable().optional()
});

export async function GET() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const config = (await TrendRssNewsConfig.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          intervalMinutes: 60,
          autoPostIntervalMinutes: 60,
          strategyGoal: "maximize_time_spend",
          safeDraftMode: true,
          status: "idle"
        }
      },
      { upsert: true, new: true }
    ).lean()) as LeanTrendConfig;

    return jsonOk({
      config: {
        ...config,
        intervalMinutes: normalizeInterval(config?.intervalMinutes),
        autoPostIntervalMinutes: normalizeInterval(config?.autoPostIntervalMinutes)
      }
    });
  } catch (error) {
    return handleRoleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(configSchema, await request.json());
    const now = new Date();
    const nextScanAt =
      payload.enabled && payload.autoRunEnabled
        ? new Date(now.getTime() + (payload.intervalMinutes ?? 60) * 60000)
        : null;
    const nextAutoPostAt =
      payload.enabled && payload.autoPostEnabled
        ? new Date(now.getTime() + (payload.autoPostIntervalMinutes ?? 60) * 60000)
        : null;
    const config = (await TrendRssNewsConfig.findOneAndUpdate(
      { userId },
      {
        ...payload,
        userId,
        status: payload.enabled ? "waiting" : "idle",
        nextScanAt,
        nextAutoPostAt,
        nextRunAt: nextScanAt,
        lastError: null
      },
      { upsert: true, new: true }
    ).lean()) as LeanTrendConfig;

    return jsonOk({
      config: {
        ...config,
        intervalMinutes: normalizeInterval(config?.intervalMinutes),
        autoPostIntervalMinutes: normalizeInterval(config?.autoPostIntervalMinutes)
      }
    }, "บันทึกโหมดจับกระแสข่าวเรียบร้อยแล้ว");
  } catch (error) {
    return handleRoleError(error);
  }
}
