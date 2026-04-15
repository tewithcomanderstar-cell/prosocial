import { randomUUID } from "crypto";
import { connectDb } from "@/lib/db";
import { createNotification, logAction, logAndNotifyError } from "@/lib/services/logging";
import { logCommentStage } from "@/lib/services/comment-logging";
import { Job } from "@/models/Job";
import { CommentInbox } from "@/models/CommentInbox";
import { FacebookConnection } from "@/models/FacebookConnection";
import { PostingSettings } from "@/models/PostingSettings";

const COMMENT_REPLY_BASE_DELAY_SECONDS = Number(process.env.COMMENT_REPLY_BASE_DELAY_SECONDS ?? "0");
const COMMENT_REPLY_SPACING_SECONDS = Number(process.env.COMMENT_REPLY_SPACING_SECONDS ?? "8");

type ReplyDecision =
  | {
      action: "reply";
      trigger: "auto-comment-pool";
      ruleId: "auto-comment-pool";
      ruleType: "auto-comment-pool";
      replyText: string;
      matchMode: "fallback";
    }
  | {
      action: "skip";
      reason: string;
    };

type FacebookWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        item?: string;
        verb?: string;
        comment_id?: string;
        parent_id?: string;
        post_id?: string;
        message?: string;
        from?: {
          id?: string;
          name?: string;
        };
      };
    }>;
  }>;
};

type IngestParams = {
  userId: string;
  pageId: string;
  authorName: string;
  message: string;
  senderId?: string;
  postId?: string;
  parentCommentId?: string;
  externalCommentId?: string;
  replyText?: string;
  autoQueue?: boolean;
  rawPayload?: unknown;
  correlationId?: string;
};

function normalizeText(input: string) {
  return input.trim().toLowerCase();
}

function randomItem<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildCommentDedupeKey(pageId: string, externalCommentId?: string) {
  return externalCommentId ? `comment-reply:${pageId}:${externalCommentId}` : null;
}

async function getAutoCommentSettings(userId: string) {
  const settings = await PostingSettings.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, new: true }
  ).lean<{
    autoCommentEnabled?: boolean;
    autoCommentPageIds?: string[];
    autoCommentReplies?: string[];
  } | null>();

  return {
    enabled: Boolean(settings?.autoCommentEnabled),
    pageIds: (settings?.autoCommentPageIds ?? []).filter(Boolean),
    replies: (settings?.autoCommentReplies ?? []).map((item) => item.trim()).filter(Boolean)
  };
}

async function findUserIdByPageId(pageId: string) {
  const connection = await FacebookConnection.findOne({ "pages.pageId": pageId }).lean<{ userId: string } | null>();
  return connection?.userId ? String(connection.userId) : null;
}

async function computeCommentReplyRunAt(userId: string, pageId: string) {
  const now = new Date();
  const baseRunAt = new Date(now.getTime() + COMMENT_REPLY_BASE_DELAY_SECONDS * 1000);
  const latestPendingReply = await Job.findOne({
    userId,
    type: "comment-reply",
    targetPageId: pageId,
    status: { $in: ["queued", "processing", "retrying", "rate_limited"] }
  })
    .sort({ nextRunAt: -1 })
    .lean<{ nextRunAt?: Date } | null>();

  if (!latestPendingReply?.nextRunAt || COMMENT_REPLY_SPACING_SECONDS <= 0) {
    return baseRunAt;
  }

  const latestRunAt = new Date(latestPendingReply.nextRunAt);
  if (latestRunAt.getTime() < baseRunAt.getTime()) {
    return baseRunAt;
  }

  return new Date(latestRunAt.getTime() + COMMENT_REPLY_SPACING_SECONDS * 1000);
}

async function pickAutoReply(userId: string, pageId: string): Promise<ReplyDecision> {
  const autoCommentSettings = await getAutoCommentSettings(userId);

  if (autoCommentSettings.enabled && autoCommentSettings.pageIds.includes(pageId) && autoCommentSettings.replies.length > 0) {
    const replyText = randomItem(autoCommentSettings.replies);
    return {
      action: "reply",
      trigger: "auto-comment-pool",
      ruleId: "auto-comment-pool",
      ruleType: "auto-comment-pool",
      replyText,
      matchMode: "fallback"
    };
  }

  return {
    action: "skip",
    reason: "Auto reply is disabled for this page or the reply library is empty"
  };
}

async function enqueueCommentReplyJob(params: {
  userId: string;
  pageId: string;
  commentInboxId: string;
  externalCommentId: string;
  replyText: string;
  correlationId?: string;
  matchedTrigger?: string;
  matchedRuleId?: string;
  matchedRuleType?: string;
}) {
  const dedupeKey = buildCommentDedupeKey(params.pageId, params.externalCommentId);
  const existingJob = dedupeKey
    ? await Job.findOne({
        dedupeKey,
        type: "comment-reply",
        status: { $in: ["queued", "processing", "retrying", "rate_limited", "success"] }
      }).lean<{ _id: string; status: string } | null>()
    : null;

  if (existingJob) {
    return { jobId: String(existingJob._id), deduped: true };
  }

  const job = await Job.create({
    userId: params.userId,
    type: "comment-reply",
    targetPageId: params.pageId,
    nextRunAt: await computeCommentReplyRunAt(params.userId, params.pageId),
    maxAttempts: 4,
    status: "queued",
    dedupeKey: dedupeKey ?? undefined,
    correlationId: params.correlationId,
    payload: {
      commentInboxId: params.commentInboxId,
      externalCommentId: params.externalCommentId,
      replyText: params.replyText,
      matchedTrigger: params.matchedTrigger,
      matchedRuleId: params.matchedRuleId,
      matchedRuleType: params.matchedRuleType
    }
  });

  return { jobId: String(job._id), deduped: false };
}

export async function ingestCommentAndMaybeQueue(params: IngestParams) {
  await connectDb();

  const correlationId = params.correlationId ?? randomUUID();
  const autoCommentSettings = await getAutoCommentSettings(params.userId);
  const autoReplyEnabled = params.autoQueue !== false && autoCommentSettings.enabled;
  const manualReplyText = params.replyText?.trim();
  const replyDecision = manualReplyText ? null : await pickAutoReply(params.userId, params.pageId);

  const effectiveReplyText = manualReplyText || (replyDecision?.action === "reply" ? replyDecision.replyText : "");
  const shouldQueue = Boolean(
    params.externalCommentId &&
      effectiveReplyText &&
      autoReplyEnabled &&
      autoCommentSettings.pageIds.includes(params.pageId)
  );

  const externalKey =
    params.externalCommentId || `manual:${params.pageId}:${normalizeText(params.authorName)}:${normalizeText(params.message)}`;

  const existing = await CommentInbox.findOne({
    pageId: params.pageId,
    externalCommentId: externalKey
  }).lean<{
    _id: string;
    status: string;
    replyExternalId?: string | null;
    replyText?: string;
  } | null>();

  const nextStatus = shouldQueue ? "queued" : "received";

  const comment = await CommentInbox.findOneAndUpdate(
    {
      pageId: params.pageId,
      externalCommentId: externalKey
    },
    {
      $set: {
        userId: params.userId,
        correlationId,
        pageId: params.pageId,
        postId: params.postId,
        parentCommentId: params.parentCommentId,
        externalCommentId: externalKey,
        authorName: params.authorName,
        senderId: params.senderId,
        message: params.message,
        rawPayload: params.rawPayload ?? null,
        normalizedType: "comment_created",
        status: existing?.replyExternalId ? existing.status : nextStatus,
        replyText: effectiveReplyText || undefined,
        matchedTrigger: replyDecision?.action === "reply" ? replyDecision.trigger : undefined,
        matchedRuleId: replyDecision?.action === "reply" ? replyDecision.ruleId : undefined,
        matchedRuleType: replyDecision?.action === "reply" ? replyDecision.ruleType : undefined,
        autoReplyEnabled,
        queuedAt: shouldQueue && !existing?.replyExternalId ? new Date() : undefined,
        replyError: null,
        receivedAt: existing ? undefined : new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const commentInboxId = String(comment._id);

  await logCommentStage({
    userId: params.userId,
    commentInboxId,
    externalCommentId: externalKey,
    correlationId,
    stage: "event_stored",
    message: existing ? "Comment event updated from webhook" : "Comment event stored from webhook",
    metadata: {
      pageId: params.pageId,
      postId: params.postId,
      parentCommentId: params.parentCommentId
    }
  });

  if (replyDecision?.action === "reply") {
    await logCommentStage({
      userId: params.userId,
      commentInboxId,
      externalCommentId: externalKey,
      correlationId,
      stage: "rule_matched",
      message: "Selected a random reply from the auto reply library",
      metadata: {
        pageId: params.pageId,
        ruleId: replyDecision.ruleId,
        ruleType: replyDecision.ruleType,
        trigger: replyDecision.trigger
      }
    });
  }

  if (existing?.replyExternalId) {
    return { comment, queuedJobId: null };
  }

  if (!shouldQueue) {
    await logAction({
      userId: params.userId,
      type: "comment",
      level: "warn",
      message: "Comment was received but auto reply is not enabled for this page or no reply library is configured",
      metadata: {
        pageId: params.pageId,
        commentInboxId,
        externalCommentId: externalKey,
        autoReplyEnabled,
        autoCommentPageSelected: autoCommentSettings.pageIds.includes(params.pageId),
        autoCommentReplyPoolSize: autoCommentSettings.replies.length,
        skipReason: replyDecision?.action === "skip" ? replyDecision.reason : null
      }
    });

    return { comment, queuedJobId: null };
  }

  const enqueueResult = await enqueueCommentReplyJob({
    userId: params.userId,
    pageId: params.pageId,
    commentInboxId,
    externalCommentId: externalKey,
    replyText: effectiveReplyText,
    correlationId,
    matchedTrigger: replyDecision?.action === "reply" ? replyDecision.trigger : undefined,
    matchedRuleId: replyDecision?.action === "reply" ? replyDecision.ruleId : undefined,
    matchedRuleType: replyDecision?.action === "reply" ? replyDecision.ruleType : undefined
  });

  await logCommentStage({
    userId: params.userId,
    commentInboxId,
    externalCommentId: externalKey,
    correlationId,
    stage: "job_enqueued",
    message: enqueueResult.deduped ? "Comment reply job deduped" : "Comment reply job queued",
    metadata: {
      pageId: params.pageId,
      jobId: enqueueResult.jobId,
      deduped: enqueueResult.deduped
    }
  });

  return { comment, queuedJobId: enqueueResult.jobId };
}

export async function retryCommentReply(userId: string, commentInboxId: string) {
  await connectDb();
  const comment = await CommentInbox.findOne({ _id: commentInboxId, userId }).lean<{
    _id: string;
    pageId: string;
    externalCommentId?: string;
    replyText?: string;
    correlationId?: string;
  } | null>();

  if (!comment) {
    throw new Error("Comment inbox entry not found");
  }

  if (!comment.externalCommentId || !comment.replyText?.trim()) {
    throw new Error("Comment reply is missing the Facebook comment ID or reply text");
  }

  await CommentInbox.findByIdAndUpdate(commentInboxId, {
    status: "queued",
    queuedAt: new Date(),
    replyError: null
  });

  const enqueueResult = await enqueueCommentReplyJob({
    userId,
    pageId: comment.pageId,
    commentInboxId: String(comment._id),
    externalCommentId: comment.externalCommentId,
    replyText: comment.replyText.trim(),
    correlationId: comment.correlationId
  });

  await logCommentStage({
    userId,
    commentInboxId: String(comment._id),
    externalCommentId: comment.externalCommentId,
    correlationId: comment.correlationId,
    stage: "job_enqueued",
    message: "Comment reply manually re-queued",
    metadata: {
      pageId: comment.pageId,
      jobId: enqueueResult.jobId
    }
  });

  return { jobId: enqueueResult.jobId };
}

export async function notifyCommentFailure(params: {
  userId: string;
  commentInboxId: string;
  pageId: string;
  externalCommentId?: string;
  correlationId?: string;
  message: string;
  error?: unknown;
}) {
  await logCommentStage({
    userId: params.userId,
    commentInboxId: params.commentInboxId,
    externalCommentId: params.externalCommentId,
    correlationId: params.correlationId,
    stage: "reply_failed",
    message: params.message,
    metadata: params.error instanceof Error ? { name: params.error.name, reason: params.error.message } : null
  });

  await logAndNotifyError({
    userId: params.userId,
    message: params.message,
    metadata: {
      commentInboxId: params.commentInboxId,
      pageId: params.pageId,
      externalCommentId: params.externalCommentId
    },
    error: params.error
  });

  await createNotification({
    userId: params.userId,
    type: "error",
    severity: "warn",
    title: "Auto Comment needs attention",
    message: params.message,
    metadata: {
      commentInboxId: params.commentInboxId,
      pageId: params.pageId,
      externalCommentId: params.externalCommentId
    }
  });
}

export async function ingestFacebookWebhookPayload(payload: FacebookWebhookPayload) {
  await connectDb();

  if (payload.object !== "page") {
    return { accepted: 0, ignored: 0, reasons: ["payload_object_not_page"] };
  }

  let accepted = 0;
  let ignored = 0;
  const reasons = new Set<string>();

  for (const entry of payload.entry ?? []) {
    const pageId = entry.id;
    if (!pageId) {
      ignored += 1;
      reasons.add("missing_page_id");
      continue;
    }

    const userId = await findUserIdByPageId(pageId);
    if (!userId) {
      ignored += 1;
      reasons.add(`page_not_connected:${pageId}`);
      continue;
    }

    for (const change of entry.changes ?? []) {
      const value = change.value;
      const isCommentEvent =
        change.field === "feed" &&
        value?.item === "comment" &&
        value?.verb === "add" &&
        value.comment_id &&
        value.message &&
        value.from?.name;

      if (!isCommentEvent) {
        ignored += 1;
        reasons.add(
          `ignored_change:${change.field ?? "unknown"}:${value?.item ?? "unknown"}:${value?.verb ?? "unknown"}`
        );
        continue;
      }

      const correlationId = randomUUID();

      await ingestCommentAndMaybeQueue({
        userId,
        pageId,
        authorName: value.from?.name ?? "Facebook user",
        senderId: value.from?.id,
        postId: value.post_id,
        parentCommentId: value.parent_id,
        message: value.message ?? "",
        externalCommentId: value.comment_id,
        autoQueue: true,
        rawPayload: { entry, change },
        correlationId
      });

      accepted += 1;
    }
  }

  return { accepted, ignored, reasons: Array.from(reasons) };
}
