import { connectDb } from "@/lib/db";
import { createNotification, logAction, logAndNotifyError } from "@/lib/services/logging";
import { Job } from "@/models/Job";
import { CommentInbox } from "@/models/CommentInbox";
import { FacebookConnection } from "@/models/FacebookConnection";
import { GrowthAutomationRule } from "@/models/GrowthAutomationRule";
import { KeywordTrigger } from "@/models/KeywordTrigger";
import { PostingSettings } from "@/models/PostingSettings";

type MatchedCommentRule = {
  trigger: string;
  ruleId: string;
  ruleType: "growth-rule" | "keyword-trigger";
  replyText: string;
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

function normalizeText(input: string) {
  return input.trim().toLowerCase();
}

async function findMatchedRule(userId: string, message: string): Promise<MatchedCommentRule | null> {
  const normalizedMessage = normalizeText(message);

  const [growthRules, keywordTriggers] = await Promise.all([
    GrowthAutomationRule.find({ userId, enabled: true }).lean<Array<{
      _id: string;
      triggerKeyword: string;
      replyText: string;
    }>>(),
    KeywordTrigger.find({ userId, enabled: true, triggerType: "comment" }).lean<Array<{
      _id: string;
      keyword: string;
      replyText?: string;
    }>>()
  ]);

  for (const rule of growthRules) {
    const trigger = normalizeText(rule.triggerKeyword);
    if (trigger && normalizedMessage.includes(trigger)) {
      return {
        trigger: rule.triggerKeyword,
        ruleId: String(rule._id),
        ruleType: "growth-rule",
        replyText: rule.replyText
      };
    }
  }

  for (const triggerRule of keywordTriggers) {
    const trigger = normalizeText(triggerRule.keyword);
    if (trigger && normalizedMessage.includes(trigger) && triggerRule.replyText?.trim()) {
      return {
        trigger: triggerRule.keyword,
        ruleId: String(triggerRule._id),
        ruleType: "keyword-trigger",
        replyText: triggerRule.replyText.trim()
      };
    }
  }

  return null;
}

async function isAutoCommentEnabled(userId: string) {
  const settings = await PostingSettings.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, new: true }
  ).lean<{ autoCommentEnabled?: boolean } | null>();

  return Boolean(settings?.autoCommentEnabled);
}

async function findUserIdByPageId(pageId: string) {
  const connection = await FacebookConnection.findOne({ "pages.pageId": pageId }).lean<{ userId: string } | null>();
  return connection?.userId ? String(connection.userId) : null;
}

export async function ingestCommentAndMaybeQueue(params: {
  userId: string;
  pageId: string;
  authorName: string;
  message: string;
  externalCommentId?: string;
  replyText?: string;
  autoQueue?: boolean;
}) {
  await connectDb();

  const matchedRule = params.replyText?.trim()
    ? null
    : await findMatchedRule(params.userId, params.message);

  const effectiveReplyText = params.replyText?.trim() || matchedRule?.replyText || "";
  const autoReplyEnabled = params.autoQueue !== false && (await isAutoCommentEnabled(params.userId));
  const shouldQueue = Boolean(autoReplyEnabled && effectiveReplyText && params.externalCommentId);
  const status = shouldQueue
    ? "queued"
    : effectiveReplyText
      ? "matched"
      : "ignored";

  const comment = await CommentInbox.findOneAndUpdate(
    {
      userId: params.userId,
      pageId: params.pageId,
      externalCommentId: params.externalCommentId || `manual:${params.pageId}:${normalizeText(params.authorName)}:${normalizeText(params.message)}`
    },
    {
      userId: params.userId,
      pageId: params.pageId,
      externalCommentId: params.externalCommentId,
      authorName: params.authorName,
      message: params.message,
      replyText: effectiveReplyText || undefined,
      status,
      matchedTrigger: matchedRule?.trigger,
      matchedRuleId: matchedRule?.ruleId,
      matchedRuleType: matchedRule?.ruleType,
      autoReplyEnabled,
      queuedAt: shouldQueue ? new Date() : undefined,
      replyError: null
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (!shouldQueue) {
    await logAction({
      userId: params.userId,
      type: "comment",
      level: effectiveReplyText ? "info" : "warn",
      message: effectiveReplyText
        ? "Comment matched a rule but was not queued for auto reply"
        : "Comment ingested with no matching auto-reply rule",
      metadata: {
        pageId: params.pageId,
        commentInboxId: String(comment._id),
        externalCommentId: params.externalCommentId,
        matchedTrigger: matchedRule?.trigger,
        autoReplyEnabled,
        hasExternalCommentId: Boolean(params.externalCommentId)
      }
    });

    return { comment, queuedJobId: null };
  }

  const job = await Job.create({
    userId: params.userId,
    type: "comment-reply",
    targetPageId: params.pageId,
    nextRunAt: new Date(),
    maxAttempts: 3,
    status: "queued",
    payload: {
      commentInboxId: String(comment._id),
      externalCommentId: params.externalCommentId,
      replyText: effectiveReplyText,
      matchedTrigger: matchedRule?.trigger,
      matchedRuleId: matchedRule?.ruleId,
      matchedRuleType: matchedRule?.ruleType
    }
  });

  await logAction({
    userId: params.userId,
    type: "comment",
    level: "info",
    message: "Comment reply queued",
    relatedJobId: String(job._id),
    metadata: {
      pageId: params.pageId,
      commentInboxId: String(comment._id),
      externalCommentId: params.externalCommentId,
      matchedTrigger: matchedRule?.trigger
    }
  });

  return { comment, queuedJobId: String(job._id) };
}

export async function retryCommentReply(userId: string, commentInboxId: string) {
  await connectDb();
  const comment = await CommentInbox.findOne({ _id: commentInboxId, userId }).lean<{
    _id: string;
    pageId: string;
    externalCommentId?: string;
    replyText?: string;
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

  const job = await Job.create({
    userId,
    type: "comment-reply",
    targetPageId: comment.pageId,
    nextRunAt: new Date(),
    maxAttempts: 3,
    status: "queued",
    payload: {
      commentInboxId: String(comment._id),
      externalCommentId: comment.externalCommentId,
      replyText: comment.replyText
    }
  });

  return { jobId: String(job._id) };
}

export async function notifyCommentFailure(params: {
  userId: string;
  commentInboxId: string;
  pageId: string;
  message: string;
  error?: unknown;
}) {
  await logAndNotifyError({
    userId: params.userId,
    message: params.message,
    metadata: {
      commentInboxId: params.commentInboxId,
      pageId: params.pageId
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
      pageId: params.pageId
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

      await ingestCommentAndMaybeQueue({
        userId,
        pageId,
        authorName: value.from?.name ?? "Facebook user",
        message: value.message ?? "",
        externalCommentId: value.comment_id,
        autoQueue: true
      });

      accepted += 1;
    }
  }

  return { accepted, ignored };
}
