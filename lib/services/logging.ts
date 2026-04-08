import { ActionLog } from "@/models/ActionLog";
import { AuditEntry } from "@/models/AuditEntry";
import { Notification } from "@/models/Notification";

type LogInput = {
  userId: string;
  type: "post" | "comment" | "error" | "queue" | "settings" | "auth" | "backup" | "token" | "analytics";
  level?: "info" | "success" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
  relatedJobId?: string;
  relatedPostId?: string;
  relatedScheduleId?: string;
};

function inferAuditAction(input: LogInput) {
  if (input.type === "post") return "post-action";
  if (input.type === "queue") return "queue-action";
  if (input.type === "settings") return "settings-update";
  if (input.type === "auth") return "auth-action";
  if (input.type === "backup") return "backup-action";
  if (input.type === "token") return "token-action";
  if (input.type === "analytics") return "analytics-action";
  return "system-event";
}

export async function logAction(input: LogInput) {
  const log = await ActionLog.create({
    userId: input.userId,
    type: input.type,
    level: input.level ?? "info",
    message: input.message,
    metadata: input.metadata ?? {},
    relatedJobId: input.relatedJobId,
    relatedPostId: input.relatedPostId,
    relatedScheduleId: input.relatedScheduleId
  });

  await AuditEntry.create({
    userId: input.userId,
    action: inferAuditAction(input),
    entityType: input.type,
    entityId: input.relatedPostId ?? input.relatedJobId ?? input.relatedScheduleId,
    summary: input.message,
    metadata: input.metadata ?? {}
  });

  return log;
}

export async function createNotification(params: {
  userId: string;
  type: "error" | "token" | "backup" | "rate_limit" | "analytics" | "system";
  severity?: "info" | "warn" | "error";
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  return Notification.create({
    userId: params.userId,
    type: params.type,
    severity: params.severity ?? "info",
    title: params.title,
    message: params.message,
    metadata: params.metadata ?? {}
  });
}

export async function logAndNotifyError(params: {
  userId: string;
  message: string;
  metadata?: Record<string, unknown>;
  relatedJobId?: string;
  relatedPostId?: string;
  relatedScheduleId?: string;
}) {
  await logAction({
    userId: params.userId,
    type: "error",
    level: "error",
    message: params.message,
    metadata: params.metadata,
    relatedJobId: params.relatedJobId,
    relatedPostId: params.relatedPostId,
    relatedScheduleId: params.relatedScheduleId
  });

  await createNotification({
    userId: params.userId,
    type: "error",
    severity: "error",
    title: "Publishing error detected",
    message: params.message,
    metadata: params.metadata
  });
}
