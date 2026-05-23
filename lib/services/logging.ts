import { connectDb } from "@/lib/db";
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

const MAX_LOG_MESSAGE_CHARS = 1000;
const MAX_LOG_STACK_CHARS = 3000;
const MAX_METADATA_STRING_CHARS = 1000;

function truncateText(value: string | null | undefined, maxLength = MAX_LOG_MESSAGE_CHARS) {
  if (!value) return value ?? null;
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateText(value, MAX_METADATA_STRING_CHARS);
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return depth >= 4 ? `[array:${value.length}]` : value.slice(0, 25).map((item) => sanitizeMetadataValue(item, depth + 1));
  }

  if (value && typeof value === "object") {
    if (depth >= 4) return "[object]";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [
          key,
          /token|secret|password|authorization|cookie|key/i.test(key)
            ? "[redacted]"
            : sanitizeMetadataValue(item, depth + 1)
        ])
    );
  }

  return value;
}

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

export function serializeError(error: unknown) {
  const redact = (value: string | null | undefined) =>
    value
      ?.replace(/(access_token=)[^&\s]+/gi, "$1[redacted]")
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
      .replace(/("pageAccessToken"\s*:\s*")[^"]+/gi, '$1[redacted]')
      .replace(/("accessToken"\s*:\s*")[^"]+/gi, '$1[redacted]')
      .replace(/("token"\s*:\s*")[^"]+/gi, '$1[redacted]') ?? null;

  if (error instanceof Error) {
    return {
      reason: truncateText(redact(error.message), MAX_LOG_MESSAGE_CHARS) ?? "unknown",
      stack: truncateText(redact(error.stack ?? null), MAX_LOG_STACK_CHARS),
      name: error.name
    };
  }

  return {
    reason: typeof error === "string" ? truncateText(redact(error), MAX_LOG_MESSAGE_CHARS) ?? "unknown" : "unknown",
    stack: null,
    name: "UnknownError"
  };
}

export async function logAction(input: LogInput) {
  await connectDb();

  const log = await ActionLog.create({
    userId: input.userId,
    type: input.type,
    level: input.level ?? "info",
    message: truncateText(input.message, MAX_LOG_MESSAGE_CHARS) ?? input.message,
    metadata: sanitizeMetadataValue(input.metadata ?? {}),
    relatedJobId: input.relatedJobId,
    relatedPostId: input.relatedPostId,
    relatedScheduleId: input.relatedScheduleId
  });

  await AuditEntry.create({
    userId: input.userId,
    action: inferAuditAction(input),
    entityType: input.type,
    entityId: input.relatedPostId ?? input.relatedJobId ?? input.relatedScheduleId,
    summary: truncateText(input.message, MAX_LOG_MESSAGE_CHARS) ?? input.message,
    metadata: sanitizeMetadataValue(input.metadata ?? {})
  });

  return log;
}

export async function logRouteError(params: {
  userId: string;
  type?: LogInput["type"];
  message: string;
  error: unknown;
  metadata?: Record<string, unknown>;
  relatedJobId?: string;
  relatedPostId?: string;
  relatedScheduleId?: string;
}) {
  const details = serializeError(params.error);
  return logAction({
    userId: params.userId,
    type: params.type ?? "error",
    level: "error",
    message: params.message,
    metadata: {
      ...params.metadata,
      ...details
    },
    relatedJobId: params.relatedJobId,
    relatedPostId: params.relatedPostId,
    relatedScheduleId: params.relatedScheduleId
  });
}

export async function safeLogAction(input: LogInput) {
  try {
    return await logAction(input);
  } catch (error) {
    console.error("[logging] unable to persist action log", serializeError(error));
    return null;
  }
}

export async function safeLogRouteError(params: {
  userId: string;
  type?: LogInput["type"];
  message: string;
  error: unknown;
  metadata?: Record<string, unknown>;
  relatedJobId?: string;
  relatedPostId?: string;
  relatedScheduleId?: string;
}) {
  try {
    return await logRouteError(params);
  } catch (loggingError) {
    console.error("[logging] unable to persist route error", {
      originalMessage: params.message,
      loggingError: serializeError(loggingError)
    });
    return null;
  }
}

export async function createNotification(params: {
  userId: string;
  type: "error" | "token" | "backup" | "rate_limit" | "analytics" | "system";
  severity?: "info" | "warn" | "error";
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  await connectDb();

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
  error?: unknown;
}) {
  await logAction({
    userId: params.userId,
    type: "error",
    level: "error",
    message: params.message,
    metadata: {
      ...(params.metadata ?? {}),
      ...(params.error ? serializeError(params.error) : {})
    },
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
