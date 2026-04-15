"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/language-provider";

type CommentRecord = {
  _id: string;
  pageId: string;
  authorName: string;
  message: string;
  status: "pending" | "matched" | "received" | "queued" | "processing" | "replying" | "replied" | "failed" | "ignored";
  replyText?: string;
  matchedTrigger?: string;
  externalCommentId?: string;
  replyError?: string | null;
  replyAttempts?: number;
  createdAt?: string;
  queuedAt?: string;
  lastAttemptAt?: string;
  repliedAt?: string;
  autoReplyEnabled?: boolean;
  matchedRuleType?: "growth-rule" | "keyword-trigger" | "auto-comment-pool";
  executionLogs?: Array<{
    _id?: string;
    stage: string;
    message: string;
    createdAt?: string;
  }>;
};

type AutoCommentConfig = {
  autoCommentEnabled: boolean;
  autoCommentPageIds: string[];
  autoCommentReplies: string[];
};

type FacebookPage = {
  pageId: string;
  name: string;
};

type GrowthRule = {
  _id: string;
  name: string;
  triggerKeyword: string;
  actionType: "invite-inbox" | "send-link" | "custom-reply";
  replyText: string;
  enabled: boolean;
};

type KeywordTrigger = {
  _id: string;
  keyword: string;
  triggerType: "post" | "comment";
  action: string;
  replyText?: string;
  enabled: boolean;
};

const emptyGrowthRule = {
  name: "",
  triggerKeyword: "",
  actionType: "custom-reply",
  replyText: "",
  linkUrl: "",
  enabled: true
};

const emptyKeywordTrigger = {
  keyword: "",
  triggerType: "comment",
  action: "reply",
  replyText: "",
  enabled: true
};

const AUTO_COMMENT_REPLY_SLOTS = 5;

const META_WEBHOOK_CHECKLIST = [
  "Meta App > Webhooks à¸•à¹‰à¸­à¸‡à¸•à¸±à¹‰à¸‡ Callback URL à¹€à¸›à¹‡à¸™ /api/facebook/webhook",
  "Verify Token à¹ƒà¸™ Meta à¸•à¹‰à¸­à¸‡à¸•à¸£à¸‡à¸à¸±à¸š FACEBOOK_WEBHOOK_VERIFY_TOKEN à¸šà¸™ Vercel",
  "à¹€à¸¥à¸·à¸­à¸ subscribe à¸—à¸µà¹ˆ Facebook Page object à¹à¸¥à¸° feed/comment events",
  "à¹€à¸žà¸ˆà¸—à¸µà¹ˆà¸•à¹‰à¸­à¸‡à¸à¸²à¸£à¸•à¸­à¸šà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¸•à¹‰à¸­à¸‡à¸–à¸¹à¸à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¹ƒà¸™à¸£à¸°à¸šà¸š à¹à¸¥à¸°à¸–à¸¹à¸à¹€à¸¥à¸·à¸­à¸à¹ƒà¸™ Auto Reply Mode",
  "Reply library à¸•à¹‰à¸­à¸‡à¸¡à¸µà¸­à¸¢à¹ˆà¸²à¸‡à¸™à¹‰à¸­à¸¢ 1 à¸Šà¹ˆà¸­à¸‡ à¸«à¸£à¸·à¸­à¸¡à¸µ rule/keyword trigger à¸—à¸µà¹ˆ match à¹„à¸”à¹‰",
  "à¸–à¹‰à¸²à¸—à¸”à¸ªà¸­à¸šà¹à¸¥à¹‰à¸§à¹„à¸¡à¹ˆà¹€à¸‚à¹‰à¸² inbox à¹ƒà¸«à¹‰à¹€à¸Šà¹‡à¸à¹ƒà¸™ Meta à¸§à¹ˆà¸² webhook event à¸–à¸¹à¸à¸ªà¹ˆà¸‡à¸ˆà¸£à¸´à¸‡"
] as const;

function statusTone(status: CommentRecord["status"]) {
  switch (status) {
    case "replied":
      return "success";
    case "queued":
    case "replying":
      return "info";
    case "failed":
      return "warn";
    case "ignored":
      return "muted";
    default:
      return "default";
  }
}

function formatBangkokTime(value?: string) {
  if (!value) return "-";

  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

function getCommentProgressNote(comment: CommentRecord, isThai: boolean) {
  switch (comment.status) {
    case "ignored":
      return isThai
        ? "à¸£à¸±à¸šà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¹à¸¥à¹‰à¸§ à¹à¸•à¹ˆà¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µ rule à¸«à¸£à¸·à¸­ random reply à¸—à¸µà¹ˆà¹ƒà¸Šà¹‰à¸•à¸­à¸šà¹„à¸”à¹‰"
        : "Comment received, but there is no matching rule or random reply available yet.";
    case "matched":
      return isThai
        ? "à¹à¸¡à¸•à¸Šà¹Œ rule à¹à¸¥à¹‰à¸§ à¹à¸•à¹ˆà¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¹„à¸”à¹‰ queue à¸•à¸­à¸šà¸à¸¥à¸±à¸š"
        : "A rule matched, but the reply has not been queued yet.";
    case "queued":
      return isThai
        ? "à¸£à¸±à¸š webhook à¹à¸¥à¹‰à¸§ à¹à¸¥à¸°à¹€à¸‚à¹‰à¸² queue à¸£à¸­à¸•à¸­à¸šà¸à¸¥à¸±à¸š"
        : "Webhook received and the reply is queued.";
    case "replying":
      return isThai
        ? "à¸£à¸°à¸šà¸šà¸à¸³à¸¥à¸±à¸‡à¸¢à¸´à¸‡ reply à¹„à¸›à¸—à¸µà¹ˆ Facebook"
        : "The system is sending the reply to Facebook now.";
    case "replied":
      return isThai ? "à¸•à¸­à¸šà¸à¸¥à¸±à¸šà¸ªà¸³à¹€à¸£à¹‡à¸ˆà¹à¸¥à¹‰à¸§" : "Reply sent successfully.";
    case "failed":
      return isThai ? "à¸£à¸°à¸šà¸šà¸žà¸¢à¸²à¸¢à¸²à¸¡à¸•à¸­à¸šà¹à¸¥à¹‰à¸§ à¹à¸•à¹ˆà¸¥à¹‰à¸¡à¹€à¸«à¸¥à¸§" : "The system tried to reply, but it failed.";
    default:
      return isThai ? "à¸£à¸±à¸šà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¹€à¸‚à¹‰à¸²à¸£à¸°à¸šà¸šà¹à¸¥à¹‰à¸§" : "Comment received by the system.";
  }
}

export function CommentAutomationPanel() {
  const { language } = useI18n();
  const isThai = language === "th";
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [growthRules, setGrowthRules] = useState<GrowthRule[]>([]);
  const [keywordTriggers, setKeywordTriggers] = useState<KeywordTrigger[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [autoConfig, setAutoConfig] = useState<AutoCommentConfig>({
    autoCommentEnabled: false,
    autoCommentPageIds: [],
    autoCommentReplies: []
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [growthForm, setGrowthForm] = useState(emptyGrowthRule);
  const [triggerForm, setTriggerForm] = useState(emptyKeywordTrigger);
  const [savingRule, setSavingRule] = useState(false);
  const [savingTrigger, setSavingTrigger] = useState(false);
  const [savingAutoConfig, setSavingAutoConfig] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const commentSummary = useMemo(
    () => ({
      received: comments.length,
      queued: comments.filter((comment) => comment.status === "queued" || comment.status === "replying").length,
      replied: comments.filter((comment) => comment.status === "replied").length,
      failed: comments.filter((comment) => comment.status === "failed").length
    }),
    [comments]
  );

  const webhookUrl = useMemo(() => {
    if (typeof window === "undefined") return "/api/facebook/webhook";
    return `${window.location.origin}/api/facebook/webhook`;
  }, []);

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      setError(null);
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      const [commentsResponse, growthRulesResponse, triggersResponse, pagesResponse, autoConfigResponse] = await Promise.all([
        fetch("/api/comments", { credentials: "include" }),
        fetch("/api/growth-rules", { credentials: "include" }),
        fetch("/api/triggers", { credentials: "include" }),
        fetch("/api/facebook/pages", { credentials: "include" }),
        fetch("/api/comments/config", { credentials: "include" })
      ]);

      const [commentsPayload, growthRulesPayload, triggersPayload, pagesPayload, autoConfigPayload] = await Promise.all([
        commentsResponse.json(),
        growthRulesResponse.json(),
        triggersResponse.json(),
        pagesResponse.json(),
        autoConfigResponse.json()
      ]);

      if (!commentsResponse.ok) {
        throw new Error(commentsPayload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¹‚à¸«à¸¥à¸”à¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¹„à¸”à¹‰" : "Unable to load comments"));
      }
      if (!growthRulesResponse.ok) {
        throw new Error(growthRulesPayload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¹‚à¸«à¸¥à¸”à¸à¸Žà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´à¹„à¸”à¹‰" : "Unable to load growth rules"));
      }
      if (!triggersResponse.ok) {
        throw new Error(triggersPayload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¹‚à¸«à¸¥à¸”à¸„à¸µà¸¢à¹Œà¹€à¸§à¸´à¸£à¹Œà¸”à¸—à¸£à¸´à¸à¹€à¸à¸­à¸£à¹Œà¹„à¸”à¹‰" : "Unable to load keyword triggers"));
      }
      if (!pagesResponse.ok) {
        throw new Error(pagesPayload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¹‚à¸«à¸¥à¸”à¹€à¸žà¸ˆ Facebook à¹„à¸”à¹‰" : "Unable to load Facebook pages"));
      }
      if (!autoConfigResponse.ok) {
        throw new Error(autoConfigPayload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¹‚à¸«à¸¥à¸”à¸„à¹ˆà¸² Auto Comment à¹„à¸”à¹‰" : "Unable to load auto comment config"));
      }

      setComments(commentsPayload.data?.comments ?? []);
      setGrowthRules(growthRulesPayload.data?.rules ?? []);
      setKeywordTriggers((triggersPayload.data?.triggers ?? []).filter((item: KeywordTrigger) => item.triggerType === "comment"));
      setPages(pagesPayload.data?.pages ?? []);
      setAutoConfig({
        autoCommentEnabled: Boolean(autoConfigPayload.data?.autoCommentEnabled),
        autoCommentPageIds: autoConfigPayload.data?.autoCommentPageIds ?? [],
        autoCommentReplies: autoConfigPayload.data?.autoCommentReplies ?? []
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¹‚à¸«à¸¥à¸”à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ Auto Comment à¹„à¸”à¹‰" : "Unable to load Auto Comment data"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function toggleAutoCommentPage(pageId: string) {
    setAutoConfig((current) => ({
      ...current,
      autoCommentPageIds: current.autoCommentPageIds.includes(pageId)
        ? current.autoCommentPageIds.filter((id) => id !== pageId)
        : [...current.autoCommentPageIds, pageId]
    }));
  }

  function updateAutoReplySlot(index: number, value: string) {
    setAutoConfig((current) => {
      const nextReplies = Array.from({ length: AUTO_COMMENT_REPLY_SLOTS }, (_, slotIndex) => current.autoCommentReplies[slotIndex] ?? "");
      nextReplies[index] = value;

      return {
        ...current,
        autoCommentReplies: nextReplies.map((item) => item.trim()).filter(Boolean)
      };
    });
  }

  async function handleSaveAutoConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingAutoConfig(true);
    setError(null);

    try {
      const response = await fetch("/api/comments/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(autoConfig)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸šà¸±à¸™à¸—à¸¶à¸à¸„à¹ˆà¸² Auto Comment à¹„à¸”à¹‰" : "Unable to save auto comment config"));
      }
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸šà¸±à¸™à¸—à¸¶à¸à¸„à¹ˆà¸² Auto Comment à¹„à¸”à¹‰" : "Unable to save auto comment config"));
    } finally {
      setSavingAutoConfig(false);
    }
  }

  async function handleCreateGrowthRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingRule(true);
    setError(null);

    try {
      const response = await fetch("/api/growth-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(growthForm)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸šà¸±à¸™à¸—à¸¶à¸ Growth Rule à¹„à¸”à¹‰" : "Unable to save growth rule"));
      }

      setGrowthForm(emptyGrowthRule);
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸šà¸±à¸™à¸—à¸¶à¸ Growth Rule à¹„à¸”à¹‰" : "Unable to save growth rule"));
    } finally {
      setSavingRule(false);
    }
  }

  async function handleCreateKeywordTrigger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingTrigger(true);
    setError(null);

    try {
      const response = await fetch("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(triggerForm)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸šà¸±à¸™à¸—à¸¶à¸ Keyword Trigger à¹„à¸”à¹‰" : "Unable to save keyword trigger"));
      }

      setTriggerForm(emptyKeywordTrigger);
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸šà¸±à¸™à¸—à¸¶à¸ Keyword Trigger à¹„à¸”à¹‰" : "Unable to save keyword trigger"));
    } finally {
      setSavingTrigger(false);
    }
  }

  async function handleRetry(commentId: string) {
    setRetryingId(commentId);
    setError(null);

    try {
      const response = await fetch(`/api/comments/${commentId}/retry`, {
        method: "POST",
        credentials: "include"
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸¥à¸­à¸‡à¸•à¸­à¸šà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¹ƒà¸«à¸¡à¹ˆà¹„à¸”à¹‰" : "Unable to retry comment reply"));
      }

      await loadData(true);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : (isThai ? "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸¥à¸­à¸‡à¸•à¸­à¸šà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¹ƒà¸«à¸¡à¹ˆà¹„à¸”à¹‰" : "Unable to retry comment reply"));
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="stack">
      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <h2>{isThai ? "à¹‚à¸«à¸¡à¸”à¸•à¸­à¸šà¸à¸¥à¸±à¸šà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´" : "Auto Reply Mode"}</h2>
          </div>
        </div>
        <form className="stack" onSubmit={handleSaveAutoConfig}>
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={autoConfig.autoCommentEnabled}
              onChange={(event) => setAutoConfig((current) => ({ ...current, autoCommentEnabled: event.target.checked }))}
            />
            <span>{isThai ? "à¸•à¸­à¸šà¸à¸¥à¸±à¸šà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´à¹ƒà¸™à¹€à¸žà¸ˆà¸—à¸µà¹ˆà¹€à¸¥à¸·à¸­à¸" : "Reply automatically to comments on selected pages"}</span>
          </label>

          <div className="stack">
            <strong>{isThai ? "à¹€à¸žà¸ˆ Facebook" : "Facebook Pages"}</strong>
            <div className="chip-grid">
              {pages.map((page) => {
                const active = autoConfig.autoCommentPageIds.includes(page.pageId);
                return (
                  <button
                    key={page.pageId}
                    type="button"
                    className={`choice-chip ${active ? "active" : ""}`}
                    onClick={() => toggleAutoCommentPage(page.pageId)}
                  >
                    {page.name}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="label">
            {isThai ? "à¸Šà¸¸à¸”à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸­à¸šà¸à¸¥à¸±à¸š" : "Reply library"}
            <div className="stack">
              {Array.from({ length: AUTO_COMMENT_REPLY_SLOTS }, (_, index) => (
                <input
                  key={`auto-reply-slot-${index}`}
                  value={autoConfig.autoCommentReplies[index] ?? ""}
                  onChange={(event) => updateAutoReplySlot(index, event.target.value)}
                  placeholder={isThai ? `à¸„à¸³à¸•à¸­à¸š ${index + 1}` : `Reply ${index + 1}`}
                />
              ))}
            </div>
          </label>

          <p style={{ color: "#64748b", margin: 0 }}>
            {isThai
              ? "à¹€à¸¡à¸·à¹ˆà¸­à¸¡à¸µà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¹€à¸‚à¹‰à¸²à¸¡à¸²à¹ƒà¸™à¹€à¸žà¸ˆà¸—à¸µà¹ˆà¹€à¸¥à¸·à¸­à¸ à¸£à¸°à¸šà¸šà¸ˆà¸°à¸ªà¸¸à¹ˆà¸¡ 1 à¸„à¸³à¸•à¸­à¸šà¸ˆà¸²à¸à¸£à¸²à¸¢à¸à¸²à¸£à¸™à¸µà¹‰à¹€à¸žà¸·à¹ˆà¸­à¸™à¸³à¹„à¸›à¸•à¸­à¸šà¸à¸¥à¸±à¸š"
              : "When a comment arrives on one of these pages, the system will randomly choose one reply from this list."}
          </p>

          <button type="submit" className="button-primary" disabled={savingAutoConfig}>
            {savingAutoConfig ? (isThai ? "à¸à¸³à¸¥à¸±à¸‡à¸šà¸±à¸™à¸—à¸¶à¸..." : "Saving...") : isThai ? "à¸šà¸±à¸™à¸—à¸¶à¸à¹‚à¸«à¸¡à¸”à¸•à¸­à¸šà¸à¸¥à¸±à¸šà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´" : "Save auto reply mode"}
          </button>
        </form>
      </section>

      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <h2>{isThai ? "à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸² Webhook" : "Webhook Setup"}</h2>
          </div>
          <button type="button" className="button-secondary" onClick={() => void loadData(true)} disabled={refreshing}>
            {refreshing ? (isThai ? "à¸à¸³à¸¥à¸±à¸‡à¸£à¸µà¹€à¸Ÿà¸£à¸Š..." : "Refreshing...") : isThai ? "à¸£à¸µà¹€à¸Ÿà¸£à¸Š" : "Refresh"}
          </button>
        </div>
        <div className="stack">
          <p>{isThai ? "à¹ƒà¸Šà¹‰ URL à¸™à¸µà¹‰à¹ƒà¸™ Meta Webhooks à¸ªà¸³à¸«à¸£à¸±à¸š event à¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¸‚à¸­à¸‡ Facebook Page" : "Use this URL in Meta Webhooks for Facebook Page comment events."}</p>
          <code>{webhookUrl}</code>
          <p>{isThai ? "Verify token: à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸² `FACEBOOK_WEBHOOK_VERIFY_TOKEN` à¹ƒà¸™ Vercel à¹à¸¥à¸°à¹ƒà¸Šà¹‰à¸„à¹ˆà¸²à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸™à¹ƒà¸™ Meta" : "Verify token: set `FACEBOOK_WEBHOOK_VERIFY_TOKEN` in Vercel and use the same value in Meta."}</p>
        </div>
      </section>

      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <h2>{isThai ? "à¹€à¸Šà¹‡à¸à¸¥à¸´à¸ªà¸•à¹Œ Meta Webhook" : "Meta Webhook Checklist"}</h2>
          </div>
        </div>
        <div className="stack">
          {META_WEBHOOK_CHECKLIST.map((item, index) => (
            <div key={item} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span className="badge badge-info">{index + 1}</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      {error ? <div className="card" style={{ borderColor: "rgba(220,38,38,.25)", color: "#b91c1c" }}>{error}</div> : null}

      <div className="grid quick-grid" style={{ alignItems: "start" }}>
        <section className="card section-card">
          <div className="section-head">
            <div className="section-title-wrap">
              <h2>{isThai ? "à¸à¸¥à¹ˆà¸­à¸‡à¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œ" : "Comment Inbox"}</h2>
            </div>
          </div>
          <div className="chip-grid">
            <span className="choice-chip active">{isThai ? "à¸£à¸±à¸šà¹€à¸‚à¹‰à¸²à¹à¸¥à¹‰à¸§" : "Received"} {commentSummary.received}</span>
            <span className="choice-chip active">{isThai ? "à¹€à¸‚à¹‰à¸²à¸„à¸´à¸§à¹à¸¥à¹‰à¸§" : "Queued"} {commentSummary.queued}</span>
            <span className="choice-chip active">{isThai ? "à¸•à¸­à¸šà¹à¸¥à¹‰à¸§" : "Replied"} {commentSummary.replied}</span>
            <span className="choice-chip active">{isThai ? "à¸¥à¹‰à¸¡à¹€à¸«à¸¥à¸§" : "Failed"} {commentSummary.failed}</span>
          </div>
          <div className="stack">
            {loading ? <p>{isThai ? "à¸à¸³à¸¥à¸±à¸‡à¹‚à¸«à¸¥à¸”à¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œ..." : "Loading comments..."}</p> : null}
            {!loading && comments.length === 0 ? <p>{isThai ? "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¹€à¸‚à¹‰à¸²à¸£à¸°à¸šà¸š" : "No comments have been ingested yet."}</p> : null}
            {!loading
              ? comments.map((comment) => (
                  <article key={comment._id} className="card" style={{ padding: 16, gap: 10, display: "grid" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                      <strong>{comment.authorName}</strong>
                      <span className={`badge badge-${statusTone(comment.status)}`}>{comment.status}</span>
                    </div>
                    <div style={{ color: "#475569" }}>
                      <div>{isThai ? "à¹€à¸žà¸ˆ" : "Page"}: {comment.pageId}</div>
                      {comment.matchedTrigger ? <div>{isThai ? "à¸—à¸£à¸´à¸à¹€à¸à¸­à¸£à¹Œà¸—à¸µà¹ˆà¸•à¸£à¸‡" : "Matched trigger"}: {comment.matchedTrigger}</div> : null}
                      {comment.matchedRuleType ? <div>{isThai ? "à¹à¸«à¸¥à¹ˆà¸‡à¸„à¸³à¸•à¸­à¸š" : "Reply source"}: {comment.matchedRuleType}</div> : null}
                      <div>{isThai ? "à¸£à¸«à¸±à¸ªà¸„à¸­à¸¡à¹€à¸¡à¸™à¸•à¹Œà¸ à¸²à¸¢à¸™à¸­à¸" : "External comment ID"}: {comment.externalCommentId || "-"}</div>
                    </div>
                    <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.message}</p>
                    <div className="card" style={{ padding: 12, background: "rgba(59,130,246,.05)" }}>
                      <strong style={{ display: "block", marginBottom: 6 }}>{isThai ? "à¸ªà¸–à¸²à¸™à¸°à¸à¸²à¸£à¸ªà¹ˆà¸‡à¸•à¸­à¸šà¸à¸¥à¸±à¸š" : "Delivery status"}</strong>
                      <div style={{ color: "#475569", marginBottom: 8 }}>{getCommentProgressNote(comment, isThai)}</div>
                      <div style={{ display: "grid", gap: 4, color: "#64748b", fontSize: 13 }}>
                        <div>{isThai ? "à¸£à¸±à¸šà¹€à¸‚à¹‰à¸²" : "Received"}: {formatBangkokTime(comment.createdAt)}</div>
                        <div>{isThai ? "à¹€à¸‚à¹‰à¸²à¸„à¸´à¸§" : "Queued"}: {formatBangkokTime(comment.queuedAt)}</div>
                        <div>{isThai ? "à¸žà¸¢à¸²à¸¢à¸²à¸¡à¸¥à¹ˆà¸²à¸ªà¸¸à¸”" : "Last attempt"}: {formatBangkokTime(comment.lastAttemptAt)}</div>
                        <div>{isThai ? "à¸•à¸­à¸šà¹à¸¥à¹‰à¸§" : "Replied"}: {formatBangkokTime(comment.repliedAt)}</div>
                        <div>{isThai ? "à¹€à¸›à¸´à¸” Auto Reply" : "Auto reply enabled"}: {comment.autoReplyEnabled ? (isThai ? "à¹ƒà¸Šà¹ˆ" : "Yes") : (isThai ? "à¹„à¸¡à¹ˆ" : "No")}</div>
                      </div>
                    </div>
                    {comment.executionLogs?.length ? (
                      <div className="card" style={{ padding: 12, background: "rgba(15,23,42,.04)" }}>
                        <strong style={{ display: "block", marginBottom: 6 }}>{isThai ? "à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸à¸²à¸£à¸—à¸³à¸‡à¸²à¸™" : "Execution history"}</strong>
                        <div style={{ display: "grid", gap: 6 }}>
                          {comment.executionLogs.map((log: NonNullable<CommentRecord["executionLogs"]>[number], index: number) => (
                            <div key={`${log.stage}-${log.createdAt ?? index}`} style={{ fontSize: 13, color: "#475569" }}>
                              <strong style={{ color: "#0f172a" }}>{log.stage}</strong>
                              {" · "}
                              <span>{log.message}</span>
                              {" · "}
                              <span>{formatBangkokTime(log.createdAt)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {comment.replyText ? (
                      <div>
                        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>{isThai ? "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸­à¸šà¸à¸¥à¸±à¸š" : "Reply"}</div>
                        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.replyText}</p>
                      </div>
                    ) : null}
                    {comment.replyError ? <div style={{ color: "#b91c1c" }}>{comment.replyError}</div> : null}
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                      <small style={{ color: "#64748b" }}>
                        {isThai ? "à¸ˆà¸³à¸™à¸§à¸™à¸„à¸£à¸±à¹‰à¸‡à¸—à¸µà¹ˆà¸¥à¸­à¸‡" : "Attempts"}: {comment.replyAttempts ?? 0}
                      </small>
                      {(comment.status === "failed" || comment.status === "matched" || comment.status === "ignored") && comment.replyText && comment.externalCommentId ? (
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={retryingId === comment._id}
                          onClick={() => void handleRetry(comment._id)}
                        >
                          {retryingId === comment._id ? (isThai ? "à¸à¸³à¸¥à¸±à¸‡à¸¥à¸­à¸‡à¹ƒà¸«à¸¡à¹ˆ..." : "Retrying...") : isThai ? "à¸¥à¸­à¸‡à¸•à¸­à¸šà¹ƒà¸«à¸¡à¹ˆ" : "Retry reply"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))
              : null}
          </div>
        </section>

        <section className="card section-card">
          <div className="section-head">
            <div className="section-title-wrap">
              <h2>{isThai ? "à¸à¸Žà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´" : "Automation Rules"}</h2>
            </div>
          </div>
          <div className="stack">
            <form className="stack" onSubmit={handleCreateGrowthRule}>
              <h3>{isThai ? "à¸à¸Žà¹€à¸•à¸´à¸šà¹‚à¸•" : "Growth Rule"}</h3>
              <input
                value={growthForm.name}
                onChange={(event) => setGrowthForm((current) => ({ ...current, name: event.target.value }))}
                placeholder={isThai ? "à¸Šà¸·à¹ˆà¸­à¸à¸Ž" : "Rule name"}
              />
              <input
                value={growthForm.triggerKeyword}
                onChange={(event) => setGrowthForm((current) => ({ ...current, triggerKeyword: event.target.value }))}
                placeholder={isThai ? "à¸„à¸µà¸¢à¹Œà¹€à¸§à¸´à¸£à¹Œà¸”à¸à¸£à¸°à¸•à¸¸à¹‰à¸™" : "Trigger keyword"}
              />
              <select
                value={growthForm.actionType}
                onChange={(event) => setGrowthForm((current) => ({ ...current, actionType: event.target.value as typeof current.actionType }))}
              >
                <option value="custom-reply">{isThai ? "à¸•à¸­à¸šà¸à¸¥à¸±à¸šà¹€à¸­à¸‡" : "Custom reply"}</option>
                <option value="send-link">{isThai ? "à¸ªà¹ˆà¸‡à¸¥à¸´à¸‡à¸à¹Œ" : "Send link"}</option>
                <option value="invite-inbox">{isThai ? "à¸Šà¸§à¸™à¹€à¸‚à¹‰à¸²à¸à¸¥à¹ˆà¸­à¸‡à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡" : "Invite inbox"}</option>
              </select>
              <textarea
                value={growthForm.replyText}
                onChange={(event) => setGrowthForm((current) => ({ ...current, replyText: event.target.value }))}
                placeholder={isThai ? "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸­à¸šà¸à¸¥à¸±à¸š" : "Reply text"}
                rows={4}
              />
              <button type="submit" className="button-primary" disabled={savingRule}>
                {savingRule ? (isThai ? "à¸à¸³à¸¥à¸±à¸‡à¸šà¸±à¸™à¸—à¸¶à¸..." : "Saving...") : isThai ? "à¸šà¸±à¸™à¸—à¸¶à¸à¸à¸Žà¹€à¸•à¸´à¸šà¹‚à¸•" : "Save growth rule"}
              </button>
            </form>

            <form className="stack" onSubmit={handleCreateKeywordTrigger}>
              <h3>{isThai ? "à¸„à¸µà¸¢à¹Œà¹€à¸§à¸´à¸£à¹Œà¸”à¸—à¸£à¸´à¸à¹€à¸à¸­à¸£à¹Œ" : "Keyword Trigger"}</h3>
              <input
                value={triggerForm.keyword}
                onChange={(event) => setTriggerForm((current) => ({ ...current, keyword: event.target.value }))}
                placeholder={isThai ? "à¸„à¸µà¸¢à¹Œà¹€à¸§à¸´à¸£à¹Œà¸”" : "Keyword"}
              />
              <input
                value={triggerForm.action}
                onChange={(event) => setTriggerForm((current) => ({ ...current, action: event.target.value }))}
                placeholder={isThai ? "à¸Šà¸·à¹ˆà¸­ action" : "Action label"}
              />
              <textarea
                value={triggerForm.replyText}
                onChange={(event) => setTriggerForm((current) => ({ ...current, replyText: event.target.value }))}
                placeholder={isThai ? "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸­à¸šà¸à¸¥à¸±à¸š" : "Reply text"}
                rows={4}
              />
              <button type="submit" className="button-primary" disabled={savingTrigger}>
                {savingTrigger ? (isThai ? "à¸à¸³à¸¥à¸±à¸‡à¸šà¸±à¸™à¸—à¸¶à¸..." : "Saving...") : isThai ? "à¸šà¸±à¸™à¸—à¸¶à¸à¸„à¸µà¸¢à¹Œà¹€à¸§à¸´à¸£à¹Œà¸”à¸—à¸£à¸´à¸à¹€à¸à¸­à¸£à¹Œ" : "Save keyword trigger"}
              </button>
            </form>

            <div className="stack">
              <h3>{isThai ? "à¸à¸Žà¸—à¸µà¹ˆà¹€à¸›à¸´à¸”à¹ƒà¸Šà¹‰à¸‡à¸²à¸™" : "Active rules"}</h3>
              {growthRules.length === 0 && keywordTriggers.length === 0 ? <p>{isThai ? "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸à¸Ž Auto Comment" : "No auto comment rules yet."}</p> : null}
              {growthRules.map((rule) => (
                <div key={rule._id} className="card" style={{ padding: 14 }}>
                  <strong>{rule.name}</strong>
                  <div style={{ color: "#64748b" }}>{isThai ? "à¸„à¸µà¸¢à¹Œà¹€à¸§à¸´à¸£à¹Œà¸”" : "Keyword"}: {rule.triggerKeyword}</div>
                  <div style={{ color: "#64748b" }}>{isThai ? "à¸„à¸³à¸•à¸­à¸š" : "Reply"}: {rule.replyText}</div>
                </div>
              ))}
              {keywordTriggers.map((trigger) => (
                <div key={trigger._id} className="card" style={{ padding: 14 }}>
                  <strong>{trigger.keyword}</strong>
                  <div style={{ color: "#64748b" }}>{isThai ? "Action" : "Action"}: {trigger.action}</div>
                  <div style={{ color: "#64748b" }}>{isThai ? "à¸„à¸³à¸•à¸­à¸š" : "Reply"}: {trigger.replyText || "-"}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

