"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppIcon } from "@/components/app-icon";
import { useI18n } from "@/components/language-provider";

type CommentStatus = "pending" | "matched" | "received" | "queued" | "processing" | "replying" | "replied" | "failed" | "ignored";

type CommentRecord = {
  _id: string;
  pageId: string;
  authorName: string;
  message: string;
  status: CommentStatus;
  replyText?: string;
  externalCommentId?: string;
  replyError?: string | null;
  replyAttempts?: number;
  createdAt?: string;
  queuedAt?: string;
  lastAttemptAt?: string;
  repliedAt?: string;
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

type Copy = {
  autoTitle: string;
  autoHint: string;
  autoToggle: string;
  pagesTitle: string;
  replyLibraryTitle: string;
  replySlot: string;
  save: string;
  saving: string;
  refresh: string;
  refreshing: string;
  inboxTitle: string;
  inboxLoading: string;
  inboxEmpty: string;
  received: string;
  queued: string;
  replied: string;
  failed: string;
  page: string;
  externalCommentId: string;
  deliveryStatus: string;
  receivedAt: string;
  queuedAt: string;
  lastAttemptAt: string;
  repliedAt: string;
  replyText: string;
  attempts: string;
  retryReply: string;
  retrying: string;
  statusLabel: Record<CommentStatus, string>;
  progressNote: Record<CommentStatus, string>;
};

const AUTO_COMMENT_REPLY_SLOTS = 5;

const copy: Record<"th" | "en", Copy> = {
  th: {
    autoTitle: "โหมดตอบกลับอัตโนมัติ",
    autoHint: "เลือกเพจที่ต้องการเปิด Auto Reply และใส่คำตอบที่ระบบจะสุ่มไปตอบคอมเมนต์แบบเรียลไทม์",
    autoToggle: "เปิดตอบกลับคอมเมนต์อัตโนมัติในสเตตัสสำหรับเพจที่เลือก",
    pagesTitle: "เลือกเพจ Facebook",
    replyLibraryTitle: "Reply library",
    replySlot: "คำตอบ",
    save: "บันทึกโหมดตอบกลับอัตโนมัติ",
    saving: "กำลังบันทึก...",
    refresh: "รีเฟรช",
    refreshing: "กำลังรีเฟรช...",
    inboxTitle: "Comment Inbox",
    inboxLoading: "กำลังโหลดคอมเมนต์...",
    inboxEmpty: "ยังไม่มีคอมเมนต์เข้า inbox",
    received: "รับเข้าแล้ว",
    queued: "เข้าคิวแล้ว",
    replied: "ตอบแล้ว",
    failed: "ล้มเหลว",
    page: "เพจ",
    externalCommentId: "Comment ID",
    deliveryStatus: "สถานะการตอบกลับ",
    receivedAt: "รับเข้า",
    queuedAt: "เข้าคิว",
    lastAttemptAt: "พยายามล่าสุด",
    repliedAt: "ตอบแล้ว",
    replyText: "ข้อความตอบกลับ",
    attempts: "จำนวนครั้งที่ลอง",
    retryReply: "ลองตอบใหม่",
    retrying: "กำลังลองใหม่...",
    statusLabel: {
      pending: "รอรับเข้า",
      matched: "เตรียมคำตอบแล้ว",
      received: "รับเข้าแล้ว",
      queued: "เข้าคิวแล้ว",
      processing: "กำลังประมวลผล",
      replying: "กำลังตอบกลับ",
      replied: "ตอบแล้ว",
      failed: "ล้มเหลว",
      ignored: "ข้ามแล้ว"
    },
    progressNote: {
      pending: "ระบบกำลังเตรียมงานตอบกลับ",
      matched: "ระบบสุ่มคำตอบจาก Reply library แล้ว",
      received: "ระบบรับคอมเมนต์เข้ามาแล้ว",
      queued: "ระบบสร้างคิวตอบกลับเรียบร้อย",
      processing: "ระบบกำลังประมวลผลคอมเมนต์นี้",
      replying: "ระบบกำลังส่งคำตอบกลับไปที่ Facebook",
      replied: "ตอบกลับสำเร็จแล้ว",
      failed: "ตอบกลับไม่สำเร็จ ลองตรวจข้อความผิดพลาดแล้วกดตอบใหม่ได้",
      ignored: "รายการนี้ถูกข้ามเพราะยังไม่พร้อมตอบกลับ"
    }
  },
  en: {
    autoTitle: "Auto Reply Mode",
    autoHint: "Select the Facebook Pages that should auto-reply and fill in the reply library the system should randomize from in real time.",
    autoToggle: "Enable automatic comment replies for the selected pages",
    pagesTitle: "Select Facebook Pages",
    replyLibraryTitle: "Reply library",
    replySlot: "Reply",
    save: "Save auto reply mode",
    saving: "Saving...",
    refresh: "Refresh",
    refreshing: "Refreshing...",
    inboxTitle: "Comment Inbox",
    inboxLoading: "Loading comments...",
    inboxEmpty: "No comments have reached the inbox yet.",
    received: "Received",
    queued: "Queued",
    replied: "Replied",
    failed: "Failed",
    page: "Page",
    externalCommentId: "Comment ID",
    deliveryStatus: "Reply status",
    receivedAt: "Received",
    queuedAt: "Queued",
    lastAttemptAt: "Last attempt",
    repliedAt: "Replied",
    replyText: "Reply text",
    attempts: "Attempts",
    retryReply: "Retry reply",
    retrying: "Retrying...",
    statusLabel: {
      pending: "Pending",
      matched: "Reply selected",
      received: "Received",
      queued: "Queued",
      processing: "Processing",
      replying: "Replying",
      replied: "Replied",
      failed: "Failed",
      ignored: "Ignored"
    },
    progressNote: {
      pending: "The system is preparing a reply job.",
      matched: "A reply has been selected from the reply library.",
      received: "The comment was received by the system.",
      queued: "The reply job is queued.",
      processing: "The system is processing this comment.",
      replying: "The system is sending the reply to Facebook.",
      replied: "The reply was sent successfully.",
      failed: "The reply failed. Review the error and retry.",
      ignored: "This item was skipped because auto reply is not ready."
    }
  }
};

function normalizeReplySlots(replies: string[]) {
  return Array.from({ length: AUTO_COMMENT_REPLY_SLOTS }, (_, index) => replies[index] ?? "");
}

function formatTimestamp(value: string | undefined, locale: "th-TH" | "en-US") {
  if (!value) return "-";

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
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

export function CommentAutomationPanel() {
  const { language } = useI18n();
  const locale = language === "th" ? "th-TH" : "en-US";
  const text = copy[language];

  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [autoConfig, setAutoConfig] = useState<AutoCommentConfig>({
    autoCommentEnabled: false,
    autoCommentPageIds: [],
    autoCommentReplies: normalizeReplySlots([])
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      setError(null);
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      const [commentsResponse, pagesResponse, autoConfigResponse] = await Promise.all([
        fetch("/api/comments", { credentials: "include", cache: "no-store" }),
        fetch("/api/facebook/pages", { credentials: "include", cache: "no-store" }),
        fetch("/api/comments/config", { credentials: "include", cache: "no-store" })
      ]);

      const [commentsPayload, pagesPayload, autoConfigPayload] = await Promise.all([
        commentsResponse.json(),
        pagesResponse.json(),
        autoConfigResponse.json()
      ]);

      if (!commentsResponse.ok) throw new Error(commentsPayload.message || "Unable to load comments");
      if (!pagesResponse.ok) throw new Error(pagesPayload.message || "Unable to load Facebook pages");
      if (!autoConfigResponse.ok) throw new Error(autoConfigPayload.message || "Unable to load auto comment config");

      setComments(commentsPayload.data?.comments ?? []);
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
      const response = await fetch("/api/comments/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          autoCommentEnabled: autoConfig.autoCommentEnabled,
          autoCommentPageIds: autoConfig.autoCommentPageIds,
          autoCommentReplies: autoConfig.autoCommentReplies.map((item) => item.trim()).filter(Boolean)
        })
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
      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <AppIcon name="integrations" className="section-icon" />
            <h2>{text.autoTitle}</h2>
          </div>
        </div>

        <form className="stack" onSubmit={handleSaveAutoConfig}>
          <p style={{ margin: 0, color: "var(--muted)" }}>{text.autoHint}</p>

          <label style={{ display: "flex", gap: 12, alignItems: "center", fontWeight: 700 }}>
            <input
              type="checkbox"
              checked={autoConfig.autoCommentEnabled}
              onChange={(event) => setAutoConfig((current) => ({ ...current, autoCommentEnabled: event.target.checked }))}
            />
            <span>{text.autoToggle}</span>
          </label>

          <div className="stack">
            <strong>{text.pagesTitle}</strong>
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
            <span>{text.replyLibraryTitle}</span>
            <div className="stack">
              {normalizeReplySlots(autoConfig.autoCommentReplies).map((value, index) => (
                <input
                  key={`reply-slot-${index}`}
                  className="input"
                  value={value}
                  onChange={(event) => updateAutoReplySlot(index, event.target.value)}
                  placeholder={`${text.replySlot} ${index + 1}`}
                />
              ))}
            </div>
          </label>

          <button type="submit" className="button" disabled={savingAutoConfig}>
            {savingAutoConfig ? text.saving : text.save}
          </button>
        </form>
      </section>

      {error ? (
        <div className="card" style={{ borderColor: "rgba(220,38,38,.25)", color: "#b91c1c" }}>
          {error}
        </div>
      ) : null}

      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <AppIcon name="bulk" className="section-icon" />
            <h2>{text.inboxTitle}</h2>
          </div>
          <button type="button" className="button-secondary" onClick={() => void loadData(true)} disabled={refreshing}>
            {refreshing ? text.refreshing : text.refresh}
          </button>
        </div>

        <div className="chip-grid">
          <span className="choice-chip active">{text.received} {commentSummary.received}</span>
          <span className="choice-chip active">{text.queued} {commentSummary.queued}</span>
          <span className="choice-chip active">{text.replied} {commentSummary.replied}</span>
          <span className="choice-chip active">{text.failed} {commentSummary.failed}</span>
        </div>

        <div className="stack">
          {loading ? <p>{text.inboxLoading}</p> : null}
          {!loading && comments.length === 0 ? <p>{text.inboxEmpty}</p> : null}
          {!loading
            ? comments.map((comment) => (
                <article key={comment._id} className="card" style={{ padding: 16, gap: 10, display: "grid" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <strong>{comment.authorName}</strong>
                    <span className={`badge badge-${statusTone(comment.status)}`}>{text.statusLabel[comment.status]}</span>
                  </div>

                  <div style={{ color: "#475569", display: "grid", gap: 4 }}>
                    <div>{text.page}: {comment.pageId}</div>
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
                    </div>
                  </div>

                  {comment.replyText ? (
                    <div>
                      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>{text.replyText}</div>
                      <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.replyText}</p>
                    </div>
                  ) : null}

                  {comment.replyError ? <div style={{ color: "#b91c1c" }}>{comment.replyError}</div> : null}

                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <small style={{ color: "#64748b" }}>{text.attempts}: {comment.replyAttempts ?? 0}</small>
                    {comment.status === "failed" && comment.replyText && comment.externalCommentId ? (
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={retryingId === comment._id}
                        onClick={() => void handleRetry(comment._id)}
                      >
                        {retryingId === comment._id ? text.retrying : text.retryReply}
                      </button>
                    ) : null}
                  </div>
                </article>
              ))
            : null}
        </div>
      </section>
    </div>
  );
}
