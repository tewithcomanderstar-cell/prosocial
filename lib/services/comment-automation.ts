import { randomUUID } from "crypto";
import { connectDb } from "@/lib/db";
import { createNotification, logAction, logAndNotifyError } from "@/lib/services/logging";
import { logCommentStage } from "@/lib/services/comment-logging";
import { Job } from "@/models/Job";
import { CommentInbox } from "@/models/CommentInbox";
import { FacebookConnection } from "@/models/FacebookConnection";
import { GrowthAutomationRule } from "@/models/GrowthAutomationRule";
import { KeywordTrigger } from "@/models/KeywordTrigger";
import { PostingSettings } from "@/models/PostingSettings";

const COMMENT_REPLY_BASE_DELAY_SECONDS = Number(process.env.COMMENT_REPLY_BASE_DELAY_SECONDS ?? "0");
const COMMENT_REPLY_SPACING_SECONDS = Number(process.env.COMMENT_REPLY_SPACING_SECONDS ?? "8");

type RuleDecision =
  | {
      action: "ignore";
      trigger: string;
      ruleId: string;
      ruleType: "keyword-trigger";
      reason: string;
    }
  | {
      action: "reply";
      trigger: string;
      ruleId: string;
      ruleType: "growth-rule" | "keyword-trigger" | "auto-comment-pool";
      replyText: string;
      matchMode: "exact" | "contains" | "fallback";
    }
  | {
      action: "manual_review";
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

async function evaluateCommentRules(userId: string, pageId: string, message: string): Promise<RuleDecision> {
  const normalizedMessage = normalizeText(message);
  const autoCommentSettings = await getAutoCommentSettings(userId);

  const [growthRules, keywordTriggers] = await Promise.all([
    GrowthAutomationRule.find({ userId, enabled: true }).lean<
      Array<{
        _id: string;
        triggerKeyword: string;
        replyText: string;
      }>
    >(),
    KeywordTrigger.find({ userId, enabled: true, triggerType: "comment" }).lean<
      Array<{
        _id: string;
        keyword: string;
        action: string;
        replyText?: string;
      }>
    >()
  ]);

  const ignoreRules = keywordTriggers.filter((rule) => {
    const action = normalizeText(rule.action ?? "");
    return action === "ignore" || action === "block";
  });

  for (const rule of ignoreRules) {
    const trigger = normalizeText(rule.keyword);
    if (trigger && normalizedMessage.includes(trigger)) {
      return {
        action: "ignore",
        trigger: rule.keyword,
        ruleId: String(rule._id),
        ruleType: "keyword-trigger",
        reason: "Matched ignore rule"
      };
    }
  }

  const replyKeywordRules = keywordTriggers.filter((rule) => {
    const action = normalizeText(rule.action ?? "");
    return action !== "ignore" && action !== "block" && rule.replyText?.trim();
  });

  for (const rule of replyKeywordRules) {
    const trigger = normalizeText(rule.keyword);
    if (trigger && normalizedMessage === trigger) {
      return {
        action: "reply",
        trigger: rule.keyword,
        ruleId: String(rule._id),
        ruleType: "keyword-trigger",
        replyText: rule.replyText!.trim(),
        matchMode: "exact"
      };
    }
  }

  for (const rule of growthRules) {
    const trigger = normalizeText(rule.triggerKeyword);
    if (trigger && normalizedMessage.includes(trigger)) {
      return {
        action: "reply",
        trigger: rule.triggerKeyword,
        ruleId: String(rule._id),
        ruleType: "growth-rule",
        replyText: rule.replyText.trim(),
        matchMode: "contains"
      };
    }
  }

  for (const rule of replyKeywordRules) {
    const trigger = normalizeText(rule.keyword);
    if (trigger && normalizedMessage.includes(trigger)) {
      return {
        action: "reply",
        trigger: rule.keyword,
        ruleId: String(rule._id),
        ruleType: "keyword-trigger",
        replyText: rule.replyText!.trim(),
        matchMode: "contains"
      };
    }
  }

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
    action: "manual_review",
    reason: "No matching rule or fallback reply configured"
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
  const ruleDecision = manualReplyText
    ? null
    : await evaluateCommentRules(params.userId, params.pageId, params.message);

  const effectiveReplyText = manualReplyText || (ruleDecision?.action === "reply" ? ruleDecision.replyText : "");
  const shouldQueue = Boolean(
    params.externalCommentId &&
      effectiveReplyText &&
      autoReplyEnabled &&
      autoCommentSettings.pageIds.includes(params.pageId) &&
      (ruleDecision?.action === "reply" || manualReplyText)
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

  const nextStatus =
    ruleDecision?.action === "ignore"
      ? "ignored"
      : shouldQueue
        ? "queued"
        : effectiveReplyText
          ? "received"
          : ruleDecision?.action === "manual_review"
            ? "received"
            : "ignored";

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
        matchedTrigger: ruleDecision && "trigger" in ruleDecision ? ruleDecision.trigger : undefined,
        matchedRuleId: ruleDecision && "ruleId" in ruleDecision ? ruleDecision.ruleId : undefined,
        matchedRuleType: ruleDecision?.action === "reply" ? ruleDecision.ruleType : undefined,
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

  if (ruleDecision?.action === "ignore") {
    await logCommentStage({
      userId: params.userId,
      commentInboxId,
      externalCommentId: externalKey,
      correlationId,
      stage: "event_ignored",
      message: ruleDecision.reason,
      metadata: {
        pageId: params.pageId,
        ruleId: ruleDecision.ruleId,
        trigger: ruleDecision.trigger
      }
    });

    return { comment, queuedJobId: null };
  }

  if (ruleDecision?.action === "reply") {
    await logCommentStage({
      userId: params.userId,
      commentInboxId,
      externalCommentId: externalKey,
      correlationId,
      stage: "rule_matched",
      message: `Matched ${ruleDecision.matchMode} reply rule`,
      metadata: {
        pageId: params.pageId,
        ruleId: ruleDecision.ruleId,
        ruleType: ruleDecision.ruleType,
        trigger: ruleDecision.trigger
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
      level: effectiveReplyText ? "info" : "warn",
      message: effectiveReplyText
        ? "Comment matched a rule but was not queued for auto reply"
        : ruleDecision?.action === "manual_review"
          ? "Comment requires manual review"
          : "Comment ingested with no matching auto-reply rule",
      metadata: {
        pageId: params.pageId,
        commentInboxId,
        externalCommentId: externalKey,
        autoReplyEnabled,
        autoCommentPageSelected: autoCommentSettings.pageIds.includes(params.pageId),
        autoCommentReplyPoolSize: autoCommentSettings.replies.length
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
    matchedTrigger: ruleDecision && "trigger" in ruleDecision ? ruleDecision.trigger : undefined,
    matchedRuleId: ruleDecision && "ruleId" in ruleDecision ? ruleDecision.ruleId : undefined,
    matchedRuleType: ruleDecision?.action === "reply" ? ruleDecision.ruleType : undefined
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
    return { accepted: 0, ignored: 0 };
  }

  let accepted = 0;
  let ignored = 0;

  for (const entry of payload.entry ?? []) {
    const pageId = entry.id;
    if (!pageId) {
      ignored += 1;
      continue;
    }

    const userId = await findUserIdByPageId(pageId);
    if (!userId) {
      ignored += 1;
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

  return { accepted, ignored };
}
