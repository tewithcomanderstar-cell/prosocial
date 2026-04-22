import { TrendExecutionLog } from "@/models/TrendExecutionLog";
import { logAction } from "@/lib/services/logging";

export async function logTrendStage(params: {
  userId: string;
  stage: string;
  message: string;
  metadata?: Record<string, unknown>;
  topicClusterId?: string | null;
  contentItemId?: string | null;
  level?: "info" | "success" | "warn" | "error";
}) {
  await TrendExecutionLog.create({
    userId: params.userId,
    topicClusterId: params.topicClusterId ?? null,
    contentItemId: params.contentItemId ?? null,
    stage: params.stage,
    message: params.message,
    metadata: params.metadata ?? {}
  });

  await logAction({
    userId: params.userId,
    type: "analytics",
    level: params.level ?? "info",
    message: `[TREND_RSS] ${params.message}`,
    metadata: {
      trendRss: true,
      stage: params.stage,
      ...(params.metadata ?? {})
    }
  });
}
