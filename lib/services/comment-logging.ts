import { CommentExecutionLog } from "@/models/CommentExecutionLog";

type CommentStage =
  | "webhook_received"
  | "webhook_verified"
  | "event_normalized"
  | "event_stored"
  | "job_enqueued"
  | "job_processing"
  | "rule_matched"
  | "reply_sent"
  | "reply_failed"
  | "event_ignored";

export async function logCommentStage(params: {
  userId: string;
  commentInboxId?: string;
  externalCommentId?: string;
  correlationId?: string;
  stage: CommentStage;
  message: string;
  metadata?: Record<string, unknown> | null;
}) {
  console.info(`[COMMENT] ${params.stage}`, {
    userId: params.userId,
    commentInboxId: params.commentInboxId,
    externalCommentId: params.externalCommentId,
    correlationId: params.correlationId,
    message: params.message,
    ...(params.metadata ?? {})
  });

  if (!params.commentInboxId) {
    return null;
  }

  return CommentExecutionLog.create({
    userId: params.userId,
    commentInboxId: params.commentInboxId,
    externalCommentId: params.externalCommentId,
    correlationId: params.correlationId,
    stage: params.stage,
    message: params.message,
    metadata: params.metadata ?? null
  });
}
