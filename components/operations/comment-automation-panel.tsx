"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppIcon } from "@/components/app-icon";
import { useI18n } from "@/components/language-provider";

type CommentStatus = "pending" | "matched" | "received" | "queued" | "processing" | "replying" | "replied" | "failed" | "ignored";
type ReplySource = "growth-rule" | "keyword-trigger" | "auto-comment-pool";

type CommentRecord = {
  _id: string;
  pageId: string;
  authorName: string;
  message: string;
  status: CommentStatus;
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
  matchedRuleType?: ReplySource;
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

type Copy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  autoReplyTitle: string;
  autoReplyHint: string;
  autoReplyToggle: string;
  pagesTitle: string;
  replyLibraryTitle: string;
  replySlot: string;
  saveAutoReply: string;
  saving: string;
  webhookTitle: string;
  webhookHint: string;
  verifyTokenHint: string;
  checklistTitle: string;
  checklistItems: string[];
  inboxTitle: string;
  inboxEmpty: string;
  inboxLoading: string;
  summaryReceived: string;
  summaryQueued: string;
  summaryReplied: string;
  summaryFailed: string;
  matchedTrigger: string;
  replySource: string;
  externalCommentId: string;
  deliveryStatus: string;
  receivedAt: string;
  queuedAt: string;
  lastAttemptAt: string;
  repliedAt: string;
  autoReplyEnabledLabel: string;
  yes: string;
  no: string;
  executionHistory: string;
  replyTextLabel: string;
  attempts: string;
  retryReply: string;
  retrying: string;
  rulesTitle: string;
  growthRuleTitle: string;
  ruleName: string;
  triggerKeyword: string;
  actionType: string;
  customReply: string;
  sendLink: string;
  inviteInbox: string;
  saveGrowthRule: string;
  keywordTriggerTitle: string;
  keyword: string;
  actionLabel: string;
  saveKeywordTrigger: string;
  activeRulesTitle: string;
  noRules: string;
  refresh: string;
  refreshing: string;
  pageLabel: string;
  statusLabel: Record<CommentStatus, string>;
  sourceLabel: Record<ReplySource, string>;
  progressNote: Record<CommentStatus, string>;
};

const AUTO_COMMENT_REPLY_SLOTS = 5;

const emptyGrowthRule = {
  name: "",
  triggerKeyword: "",
  actionType: "custom-reply" as const,
  replyText: "",
  linkUrl: "",
  enabled: true
};

const emptyKeywordTrigger = {
  keyword: "",
  triggerType: "comment" as const,
  action: "reply",
  replyText: "",
  enabled: true
};

const copy: Record<"th" | "en", Copy> = {
  th: {
    eyebrow: "Facebook Auto Comment",
    title: "ตอบคอมเมนต์อัตโนมัติแบบเรียลไทม์",
    subtitle: "รับคอมเมนต์จาก Meta Webhook เข้าระบบทันที จับกฎที่ตรง แล้วส่งคำตอบกลับพร้อมสถานะครบในหน้าเดียว",
    autoReplyTitle: "โหมดตอบกลับอัตโนมัติ",
    autoReplyHint: "เลือกเพจที่จะเปิด Auto Reply และตั้งคลังคำตอบที่ระบบจะสุ่มไปตอบให้เอง",
    autoReplyToggle: "เปิดตอบกลับคอมเมนต์อัตโนมัติสำหรับเพจที่เลือก",
    pagesTitle: "เลือกเพจ Facebook",
    replyLibraryTitle: "Reply library",
    replySlot: "คำตอบ",
    saveAutoReply: "บันทึกโหมดตอบกลับอัตโนมัติ",
    saving: "กำลังบันทึก...",
    webhookTitle: "Webhook Setup",
    webhookHint: "ใช้ URL นี้ใน Meta Webhooks สำหรับรับ event คอมเมนต์ของ Facebook Page",
    verifyTokenHint: "Verify token: ตั้งค่า FACEBOOK_WEBHOOK_VERIFY_TOKEN ใน Vercel และใช้ค่าเดียวกันใน Meta",
    checklistTitle: "Meta Webhook Checklist",
    checklistItems: [
      "ไปที่ Meta App > Webhooks แล้วตั้ง Callback URL เป็น /api/facebook/webhook",
      "ตั้ง Verify Token ใน Meta ให้ตรงกับค่า FACEBOOK_WEBHOOK_VERIFY_TOKEN บน Vercel",
      "Subscribe Facebook Page object และเปิด feed / comment events",
      "เชื่อมเพจที่ต้องการตอบคอมเมนต์ไว้ในระบบ และเลือกเพจนั้นใน Auto Reply Mode",
      "ใส่ Reply library อย่างน้อย 1 ช่อง หรือสร้าง rule / keyword trigger ที่แมตช์ได้",
      "ถ้าทดสอบแล้วคอมเมนต์ไม่เข้า inbox ให้เช็กที่ Meta ว่ามี webhook event ถูกส่งจริง"
    ],
    inboxTitle: "Comment Inbox",
    inboxEmpty: "ยังไม่มีคอมเมนต์เข้า inbox",
    inboxLoading: "กำลังโหลดคอมเมนต์...",
    summaryReceived: "รับเข้าแล้ว",
    summaryQueued: "เข้าคิวแล้ว",
    summaryReplied: "ตอบแล้ว",
    summaryFailed: "ล้มเหลว",
    matchedTrigger: "ทริกเกอร์ที่ตรง",
    replySource: "แหล่งคำตอบ",
    externalCommentId: "External comment ID",
    deliveryStatus: "สถานะการส่งตอบกลับ",
    receivedAt: "รับเข้า",
    queuedAt: "เข้าคิว",
    lastAttemptAt: "พยายามล่าสุด",
    repliedAt: "ตอบแล้ว",
    autoReplyEnabledLabel: "เปิด Auto Reply",
    yes: "ใช่",
    no: "ไม่ใช่",
    executionHistory: "ประวัติการทำงาน",
    replyTextLabel: "ข้อความตอบกลับ",
    attempts: "จำนวนครั้งที่ลอง",
    retryReply: "ลองตอบใหม่",
    retrying: "กำลังลองใหม่...",
    rulesTitle: "Automation Rules",
    growthRuleTitle: "Growth Rule",
    ruleName: "ชื่อกฎ",
    triggerKeyword: "คีย์เวิร์ดกระตุ้น",
    actionType: "ประเภทการตอบ",
    customReply: "ตอบกลับเอง",
    sendLink: "ส่งลิงก์",
    inviteInbox: "ชวนเข้ากล่องข้อความ",
    saveGrowthRule: "บันทึก Growth Rule",
    keywordTriggerTitle: "Keyword Trigger",
    keyword: "คีย์เวิร์ด",
    actionLabel: "ชื่อ Action",
    saveKeywordTrigger: "บันทึก Keyword Trigger",
    activeRulesTitle: "กฎที่เปิดใช้งาน",
    noRules: "ยังไม่มีกฎสำหรับ Auto Comment",
    refresh: "รีเฟรช",
    refreshing: "กำลังรีเฟรช...",
    pageLabel: "เพจ",
    statusLabel: {
      pending: "รอรับเข้า",
      matched: "จับกฎได้แล้ว",
      received: "รับเข้าแล้ว",
      queued: "เข้าคิวแล้ว",
      processing: "กำลังประมวลผล",
      replying: "กำลังตอบกลับ",
      replied: "ตอบแล้ว",
      failed: "ล้มเหลว",
      ignored: "ข้ามแล้ว"
    },
    sourceLabel: {
      "growth-rule": "Growth Rule",
      "keyword-trigger": "Keyword Trigger",
      "auto-comment-pool": "Reply library"
    },
    progressNote: {
      pending: "ระบบสร้างรายการไว้แล้วและกำลังรอขั้นตอนถัดไป",
      matched: "ระบบเจอกฎที่ตรงแล้ว แต่ยังไม่ได้สร้างงานตอบกลับ",
      received: "ระบบรับคอมเมนต์เข้าแล้ว กำลังตัดสินใจว่าจะตอบอย่างไร",
      queued: "ระบบรับ webhook แล้วและสร้างงานตอบกลับเรียบร้อย",
      processing: "ระบบกำลังประมวลผลคอมเมนต์นี้อยู่",
      replying: "ระบบกำลังยิงคำตอบกลับไปที่ Facebook",
      replied: "ตอบกลับสำเร็จแล้ว",
      failed: "ระบบพยายามตอบแล้ว แต่ยังล้มเหลว ต้องตรวจ error ต่อ",
      ignored: "คอมเมนต์นี้ถูกข้ามตามกฎ หรือยังไม่มีกฎหรือคำตอบที่ใช้ตอบได้"
    }
  },
  en: {
    eyebrow: "Facebook Auto Comment",
    title: "Real-time automatic comment replies",
    subtitle: "Receive Facebook Page comments from Meta Webhooks, match the right rule, and track every reply from inbox to success in one clean workspace.",
    autoReplyTitle: "Auto Reply Mode",
    autoReplyHint: "Choose which Facebook Pages can auto-reply and provide a reply library for randomized responses.",
    autoReplyToggle: "Enable automatic comment replies for the selected pages",
    pagesTitle: "Facebook Pages",
    replyLibraryTitle: "Reply library",
    replySlot: "Reply",
    saveAutoReply: "Save auto reply mode",
    saving: "Saving...",
    webhookTitle: "Webhook Setup",
    webhookHint: "Use this URL in Meta Webhooks for Facebook Page comment events.",
    verifyTokenHint: "Verify token: set FACEBOOK_WEBHOOK_VERIFY_TOKEN in Vercel and use the same value in Meta.",
    checklistTitle: "Meta Webhook Checklist",
    checklistItems: [
      "In Meta App > Webhooks, set the Callback URL to /api/facebook/webhook.",
      "Use the same Verify Token in Meta and in FACEBOOK_WEBHOOK_VERIFY_TOKEN on Vercel.",
      "Subscribe the Facebook Page object and enable feed / comment events.",
      "Connect the target page in this system and include it in Auto Reply Mode.",
      "Add at least one reply in the Reply library, or create a matching rule or keyword trigger.",
      "If comments do not appear in the inbox, confirm that Meta is actually delivering webhook events."
    ],
    inboxTitle: "Comment Inbox",
    inboxEmpty: "No comments have reached the inbox yet.",
    inboxLoading: "Loading comments...",
    summaryReceived: "Received",
    summaryQueued: "Queued",
    summaryReplied: "Replied",
    summaryFailed: "Failed",
    matchedTrigger: "Matched trigger",
    replySource: "Reply source",
    externalCommentId: "External comment ID",
    deliveryStatus: "Delivery status",
    receivedAt: "Received",
    queuedAt: "Queued",
    lastAttemptAt: "Last attempt",
    repliedAt: "Replied",
    autoReplyEnabledLabel: "Auto reply enabled",
    yes: "Yes",
    no: "No",
    executionHistory: "Execution history",
    replyTextLabel: "Reply text",
    attempts: "Attempts",
    retryReply: "Retry reply",
    retrying: "Retrying...",
    rulesTitle: "Automation Rules",
    growthRuleTitle: "Growth Rule",
    ruleName: "Rule name",
    triggerKeyword: "Trigger keyword",
    actionType: "Action type",
    customReply: "Custom reply",
    sendLink: "Send link",
    inviteInbox: "Invite inbox",
    saveGrowthRule: "Save growth rule",
    keywordTriggerTitle: "Keyword Trigger",
    keyword: "Keyword",
    actionLabel: "Action label",
    saveKeywordTrigger: "Save keyword trigger",
    activeRulesTitle: "Active rules",
    noRules: "No auto comment rules yet.",
    refresh: "Refresh",
    refreshing: "Refreshing...",
    pageLabel: "Page",
    statusLabel: {
      pending: "Pending",
      matched: "Matched",
      received: "Received",
      queued: "Queued",
      processing: "Processing",
      replying: "Replying",
      replied: "Replied",
      failed: "Failed",
      ignored: "Ignored"
    },
    sourceLabel: {
      "growth-rule": "Growth Rule",
      "keyword-trigger": "Keyword Trigger",
      "auto-comment-pool": "Reply library"
    },
    progressNote: {
      pending: "The comment was captured and is waiting for the next processing step.",
      matched: "A rule matched, but the reply job has not been created yet.",
      received: "The comment reached the system and is waiting for a reply decision.",
      queued: "The webhook was accepted and the reply job is queued.",
      processing: "The system is processing this comment now.",
      replying: "The system is sending the reply to Facebook right now.",
      replied: "The reply was sent successfully.",
      failed: "The system tried to reply, but it failed and needs attention.",
      ignored: "This comment was ignored by your rules, or no safe reply was available."
    }
  }
};

function normalizeReplySlots(replies: string[]) {
  return Array.from({ length: AUTO_COMMENT_REPLY_SLOTS }, (_, index) => replies[index] ?? "");
}

function statusTone(status: CommentStatus) {
  switch (status) {
    case "replied":
      return "success";
    case "queued":
    case "processing":
    case "replying":
      return "info";
    case "failed":
      return "warn";
    case "ignored":
      return "neutral";
    default:
      return "default";
  }
}

function formatTimestamp(value: string | undefined, locale: "th-TH" | "en-US") {
  if (!value) return "-";

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

export function CommentAutomationPanel() {
  const { language } = useI18n();
  const isThai = language === "th";
  const locale = isThai ? "th-TH" : "en-US";
  const text = copy[language];

  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [growthRules, setGrowthRules] = useState<GrowthRule[]>([]);
  const [keywordTriggers, setKeywordTriggers] = useState<KeywordTrigger[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [autoConfig, setAutoConfig] = useState<AutoCommentConfig>({
    autoCommentEnabled: false,
    autoCommentPageIds: [],
    autoCommentReplies: normalizeReplySlots([])
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
      queued: comments.filter((comment) => ["queued", "processing", "replying"].includes(comment.status)).length,
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
        fetch("/api/comments", { credentials: "include", cache: "no-store" }),
        fetch("/api/growth-rules", { credentials: "include", cache: "no-store" }),
        fetch("/api/triggers", { credentials: "include", cache: "no-store" }),
        fetch("/api/facebook/pages", { credentials: "include", cache: "no-store" }),
        fetch("/api/comments/config", { credentials: "include", cache: "no-store" })
      ]);

      const [commentsPayload, growthRulesPayload, triggersPayload, pagesPayload, autoConfigPayload] = await Promise.all([
        commentsResponse.json(),
        growthRulesResponse.json(),
        triggersResponse.json(),
        pagesResponse.json(),
        autoConfigResponse.json()
      ]);

      if (!commentsResponse.ok) throw new Error(commentsPayload.message || "Unable to load comments");
      if (!growthRulesResponse.ok) throw new Error(growthRulesPayload.message || "Unable to load growth rules");
      if (!triggersResponse.ok) throw new Error(triggersPayload.message || "Unable to load keyword triggers");
      if (!pagesResponse.ok) throw new Error(pagesPayload.message || "Unable to load Facebook pages");
      if (!autoConfigResponse.ok) throw new Error(autoConfigPayload.message || "Unable to load auto comment config");

      setComments(commentsPayload.data?.comments ?? []);
      setGrowthRules(growthRulesPayload.data?.rules ?? []);
      setKeywordTriggers((triggersPayload.data?.triggers ?? []).filter((item: KeywordTrigger) => item.triggerType === "comment"));
      setPages(pagesPayload.data?.pages ?? []);
      setAutoConfig({
        autoCommentEnabled: Boolean(autoConfigPayload.data?.autoCommentEnabled),
        autoCommentPageIds: autoConfigPayload.data?.autoCommentPageIds ?? [],
        autoCommentReplies: normalizeReplySlots(autoConfigPayload.data?.autoCommentReplies ?? [])
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load Auto Comment data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadData(true);
    }, 12000);

    return () => window.clearInterval(timer);
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
      const nextReplies = [...normalizeReplySlots(current.autoCommentReplies)];
      nextReplies[index] = value;
      return { ...current, autoCommentReplies: nextReplies };
    });
  }

  async function handleSaveAutoConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingAutoConfig(true);
    setError(null);

    try {
      const payload = {
        autoCommentEnabled: autoConfig.autoCommentEnabled,
        autoCommentPageIds: autoConfig.autoCommentPageIds,
        autoCommentReplies: autoConfig.autoCommentReplies.map((item) => item.trim()).filter(Boolean)
      };

      const response = await fetch("/api/comments/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to save auto comment config");

      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save auto comment config");
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
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to save growth rule");

      setGrowthForm(emptyGrowthRule);
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save growth rule");
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
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to save keyword trigger");

      setTriggerForm(emptyKeywordTrigger);
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save keyword trigger");
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
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to retry comment reply");

      await loadData(true);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Unable to retry comment reply");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="stack page-stack">
      <section className="hero">
        <div className="eyebrow">{text.eyebrow}</div>
        <h1 className="page-title">{text.title}</h1>
        <p style={{ maxWidth: 840, color: "var(--muted)", fontSize: "1rem", lineHeight: 1.7, margin: 0 }}>{text.subtitle}</p>
      </section>

      <div className="grid quick-grid">
        <article className="card quick-card"><div className="quick-card-head"><AppIcon name="integrations" className="quick-icon" /><h2>{text.summaryReceived}</h2></div><div className="stat"><strong>{commentSummary.received}</strong></div></article>
        <article className="card quick-card"><div className="quick-card-head"><AppIcon name="bulk" className="quick-icon" /><h2>{text.summaryQueued}</h2></div><div className="stat"><strong>{commentSummary.queued}</strong></div></article>
        <article className="card quick-card"><div className="quick-card-head"><AppIcon name="facebook" className="quick-icon" /><h2>{text.summaryReplied}</h2></div><div className="stat"><strong>{commentSummary.replied}</strong></div></article>
        <article className="card quick-card"><div className="quick-card-head"><AppIcon name="logs" className="quick-icon" /><h2>{text.summaryFailed}</h2></div><div className="stat"><strong>{commentSummary.failed}</strong></div></article>
      </div>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <section className="card section-card">
          <div className="section-head"><div className="section-title-wrap"><AppIcon name="integrations" className="section-icon" /><h2>{text.autoReplyTitle}</h2></div></div>
          <form className="stack" onSubmit={handleSaveAutoConfig}>
            <p style={{ margin: 0, color: "var(--muted)" }}>{text.autoReplyHint}</p>
            <label style={{ display: "flex", gap: 12, alignItems: "center", fontWeight: 700 }}>
              <input type="checkbox" checked={autoConfig.autoCommentEnabled} onChange={(event) => setAutoConfig((current) => ({ ...current, autoCommentEnabled: event.target.checked }))} />
              <span>{text.autoReplyToggle}</span>
            </label>
            <div className="stack">
              <strong>{text.pagesTitle}</strong>
              <div className="chip-grid">
                {pages.map((page) => {
                  const active = autoConfig.autoCommentPageIds.includes(page.pageId);
                  return <button key={page.pageId} type="button" className={`choice-chip ${active ? "active" : ""}`} onClick={() => toggleAutoCommentPage(page.pageId)}>{page.name}</button>;
                })}
              </div>
            </div>
            <label className="label">
              <span>{text.replyLibraryTitle}</span>
              <div className="stack">
                {normalizeReplySlots(autoConfig.autoCommentReplies).map((value, index) => (
                  <input key={`reply-slot-${index}`} className="input" value={value} onChange={(event) => updateAutoReplySlot(index, event.target.value)} placeholder={`${text.replySlot} ${index + 1}`} />
                ))}
              </div>
            </label>
            <button type="submit" className="button" disabled={savingAutoConfig}>{savingAutoConfig ? text.saving : text.saveAutoReply}</button>
          </form>
        </section>

        <section className="card section-card">
          <div className="section-head">
            <div className="section-title-wrap"><AppIcon name="facebook" className="section-icon" /><h2>{text.webhookTitle}</h2></div>
            <button type="button" className="button-secondary" onClick={() => void loadData(true)} disabled={refreshing}>{refreshing ? text.refreshing : text.refresh}</button>
          </div>
          <div className="stack">
            <p style={{ margin: 0, color: "var(--muted)" }}>{text.webhookHint}</p>
            <code>{webhookUrl}</code>
            <p style={{ margin: 0, color: "var(--muted)" }}>{text.verifyTokenHint}</p>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            <h3>{text.checklistTitle}</h3>
            {text.checklistItems.map((item, index) => (
              <div key={item} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span className="badge badge-info">{index + 1}</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {error ? <div className="card" style={{ borderColor: "rgba(220,38,38,.25)", color: "#b91c1c" }}>{error}</div> : null}

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <section className="card section-card">
          <div className="section-head"><div className="section-title-wrap"><AppIcon name="bulk" className="section-icon" /><h2>{text.inboxTitle}</h2></div></div>
          <div className="chip-grid">
            <span className="choice-chip active">{text.summaryReceived} {commentSummary.received}</span>
            <span className="choice-chip active">{text.summaryQueued} {commentSummary.queued}</span>
            <span className="choice-chip active">{text.summaryReplied} {commentSummary.replied}</span>
            <span className="choice-chip active">{text.summaryFailed} {commentSummary.failed}</span>
          </div>
          <div className="stack">
            {loading ? <p>{text.inboxLoading}</p> : null}
            {!loading && comments.length === 0 ? <p>{text.inboxEmpty}</p> : null}
            {!loading ? comments.map((comment) => (
              <article key={comment._id} className="card" style={{ padding: 16, gap: 10, display: "grid" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}><strong>{comment.authorName}</strong><span className={`badge badge-${statusTone(comment.status)}`}>{text.statusLabel[comment.status]}</span></div>
                <div style={{ color: "#475569", display: "grid", gap: 4 }}>
                  <div>{text.pageLabel}: {comment.pageId}</div>
                  {comment.matchedTrigger ? <div>{text.matchedTrigger}: {comment.matchedTrigger}</div> : null}
                  {comment.matchedRuleType ? <div>{text.replySource}: {text.sourceLabel[comment.matchedRuleType]}</div> : null}
                  <div>{text.externalCommentId}: {comment.externalCommentId || "-"}</div>
                </div>
                <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.message}</p>
                <div className="card" style={{ padding: 12, background: "rgba(59,130,246,.05)" }}>
                  <strong style={{ display: "block", marginBottom: 6 }}>{text.deliveryStatus}</strong>
                  <div style={{ color: "#475569", marginBottom: 8 }}>{text.progressNote[comment.status]}</div>
                  <div style={{ display: "grid", gap: 4, color: "#64748b", fontSize: 13 }}>
                    <div>{text.receivedAt}: {formatTimestamp(comment.createdAt, locale)}</div>
                    <div>{text.queuedAt}: {formatTimestamp(comment.queuedAt, locale)}</div>
                    <div>{text.lastAttemptAt}: {formatTimestamp(comment.lastAttemptAt, locale)}</div>
                    <div>{text.repliedAt}: {formatTimestamp(comment.repliedAt, locale)}</div>
                    <div>{text.autoReplyEnabledLabel}: {comment.autoReplyEnabled ? text.yes : text.no}</div>
                  </div>
                </div>
                {comment.executionLogs?.length ? <div className="card" style={{ padding: 12, background: "rgba(15,23,42,.04)" }}><strong style={{ display: "block", marginBottom: 6 }}>{text.executionHistory}</strong><div style={{ display: "grid", gap: 6 }}>{comment.executionLogs.map((log, index) => <div key={`${log.stage}-${log.createdAt ?? index}`} style={{ fontSize: 13, color: "#475569" }}><strong style={{ color: "#0f172a" }}>{log.stage}</strong>{" · "}<span>{log.message}</span>{" · "}<span>{formatTimestamp(log.createdAt, locale)}</span></div>)}</div></div> : null}
                {comment.replyText ? <div><div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>{text.replyTextLabel}</div><p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.replyText}</p></div> : null}
                {comment.replyError ? <div style={{ color: "#b91c1c" }}>{comment.replyError}</div> : null}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <small style={{ color: "#64748b" }}>{text.attempts}: {comment.replyAttempts ?? 0}</small>
                  {(comment.status === "failed" || comment.status === "matched" || comment.status === "ignored") && comment.replyText && comment.externalCommentId ? <button type="button" className="button-secondary" disabled={retryingId === comment._id} onClick={() => void handleRetry(comment._id)}>{retryingId === comment._id ? text.retrying : text.retryReply}</button> : null}
                </div>
              </article>
            )) : null}
          </div>
        </section>

        <section className="card section-card">
          <div className="section-head"><div className="section-title-wrap"><AppIcon name="settings" className="section-icon" /><h2>{text.rulesTitle}</h2></div></div>
          <div className="stack">
            <form className="stack" onSubmit={handleCreateGrowthRule}>
              <h3>{text.growthRuleTitle}</h3>
              <input className="input" value={growthForm.name} onChange={(event) => setGrowthForm((current) => ({ ...current, name: event.target.value }))} placeholder={text.ruleName} />
              <input className="input" value={growthForm.triggerKeyword} onChange={(event) => setGrowthForm((current) => ({ ...current, triggerKeyword: event.target.value }))} placeholder={text.triggerKeyword} />
              <select className="select" value={growthForm.actionType} onChange={(event) => setGrowthForm((current) => ({ ...current, actionType: event.target.value as typeof current.actionType }))}><option value="custom-reply">{text.customReply}</option><option value="send-link">{text.sendLink}</option><option value="invite-inbox">{text.inviteInbox}</option></select>
              <textarea className="textarea" value={growthForm.replyText} onChange={(event) => setGrowthForm((current) => ({ ...current, replyText: event.target.value }))} placeholder={text.replyTextLabel} rows={4} />
              <button type="submit" className="button" disabled={savingRule}>{savingRule ? text.saving : text.saveGrowthRule}</button>
            </form>
            <form className="stack" onSubmit={handleCreateKeywordTrigger}>
              <h3>{text.keywordTriggerTitle}</h3>
              <input className="input" value={triggerForm.keyword} onChange={(event) => setTriggerForm((current) => ({ ...current, keyword: event.target.value }))} placeholder={text.keyword} />
              <input className="input" value={triggerForm.action} onChange={(event) => setTriggerForm((current) => ({ ...current, action: event.target.value }))} placeholder={text.actionLabel} />
              <textarea className="textarea" value={triggerForm.replyText} onChange={(event) => setTriggerForm((current) => ({ ...current, replyText: event.target.value }))} placeholder={text.replyTextLabel} rows={4} />
              <button type="submit" className="button" disabled={savingTrigger}>{savingTrigger ? text.saving : text.saveKeywordTrigger}</button>
            </form>
            <div className="stack">
              <h3>{text.activeRulesTitle}</h3>
              {growthRules.length === 0 && keywordTriggers.length === 0 ? <p>{text.noRules}</p> : null}
              {growthRules.map((rule) => <div key={rule._id} className="card" style={{ padding: 14 }}><strong>{rule.name}</strong><div style={{ color: "#64748b" }}>{text.triggerKeyword}: {rule.triggerKeyword}</div><div style={{ color: "#64748b" }}>{text.replyTextLabel}: {rule.replyText}</div></div>)}
              {keywordTriggers.map((trigger) => <div key={trigger._id} className="card" style={{ padding: 14 }}><strong>{trigger.keyword}</strong><div style={{ color: "#64748b" }}>{text.actionLabel}: {trigger.action}</div><div style={{ color: "#64748b" }}>{text.replyTextLabel}: {trigger.replyText || "-"}</div></div>)}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
