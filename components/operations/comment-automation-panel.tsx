"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/language-provider";

type CommentRecord = {
  _id: string;
  pageId: string;
  authorName: string;
  message: string;
  status: "pending" | "matched" | "queued" | "replying" | "replied" | "failed" | "ignored";
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
  "Meta App > Webhooks ต้องตั้ง Callback URL เป็น /api/facebook/webhook",
  "Verify Token ใน Meta ต้องตรงกับ FACEBOOK_WEBHOOK_VERIFY_TOKEN บน Vercel",
  "เลือก subscribe ที่ Facebook Page object และ feed/comment events",
  "เพจที่ต้องการตอบคอมเมนต์ต้องถูกเชื่อมในระบบ และถูกเลือกใน Auto Reply Mode",
  "Reply library ต้องมีอย่างน้อย 1 ช่อง หรือมี rule/keyword trigger ที่ match ได้",
  "ถ้าทดสอบแล้วไม่เข้า inbox ให้เช็กใน Meta ว่า webhook event ถูกส่งจริง"
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
        ? "รับคอมเมนต์แล้ว แต่ยังไม่มี rule หรือ random reply ที่ใช้ตอบได้"
        : "Comment received, but there is no matching rule or random reply available yet.";
    case "matched":
      return isThai
        ? "แมตช์ rule แล้ว แต่ยังไม่ได้ queue ตอบกลับ"
        : "A rule matched, but the reply has not been queued yet.";
    case "queued":
      return isThai
        ? "รับ webhook แล้ว และเข้า queue รอตอบกลับ"
        : "Webhook received and the reply is queued.";
    case "replying":
      return isThai
        ? "ระบบกำลังยิง reply ไปที่ Facebook"
        : "The system is sending the reply to Facebook now.";
    case "replied":
      return isThai ? "ตอบกลับสำเร็จแล้ว" : "Reply sent successfully.";
    case "failed":
      return isThai ? "ระบบพยายามตอบแล้ว แต่ล้มเหลว" : "The system tried to reply, but it failed.";
    default:
      return isThai ? "รับคอมเมนต์เข้าระบบแล้ว" : "Comment received by the system.";
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
        throw new Error(commentsPayload.message || (isThai ? "ไม่สามารถโหลดคอมเมนต์ได้" : "Unable to load comments"));
      }
      if (!growthRulesResponse.ok) {
        throw new Error(growthRulesPayload.message || (isThai ? "ไม่สามารถโหลดกฎอัตโนมัติได้" : "Unable to load growth rules"));
      }
      if (!triggersResponse.ok) {
        throw new Error(triggersPayload.message || (isThai ? "ไม่สามารถโหลดคีย์เวิร์ดทริกเกอร์ได้" : "Unable to load keyword triggers"));
      }
      if (!pagesResponse.ok) {
        throw new Error(pagesPayload.message || (isThai ? "ไม่สามารถโหลดเพจ Facebook ได้" : "Unable to load Facebook pages"));
      }
      if (!autoConfigResponse.ok) {
        throw new Error(autoConfigPayload.message || (isThai ? "ไม่สามารถโหลดค่า Auto Comment ได้" : "Unable to load auto comment config"));
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
      setError(loadError instanceof Error ? loadError.message : (isThai ? "ไม่สามารถโหลดข้อมูล Auto Comment ได้" : "Unable to load Auto Comment data"));
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
        throw new Error(payload.message || (isThai ? "ไม่สามารถบันทึกค่า Auto Comment ได้" : "Unable to save auto comment config"));
      }
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (isThai ? "ไม่สามารถบันทึกค่า Auto Comment ได้" : "Unable to save auto comment config"));
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
        throw new Error(payload.message || (isThai ? "ไม่สามารถบันทึก Growth Rule ได้" : "Unable to save growth rule"));
      }

      setGrowthForm(emptyGrowthRule);
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (isThai ? "ไม่สามารถบันทึก Growth Rule ได้" : "Unable to save growth rule"));
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
        throw new Error(payload.message || (isThai ? "ไม่สามารถบันทึก Keyword Trigger ได้" : "Unable to save keyword trigger"));
      }

      setTriggerForm(emptyKeywordTrigger);
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (isThai ? "ไม่สามารถบันทึก Keyword Trigger ได้" : "Unable to save keyword trigger"));
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
        throw new Error(payload.message || (isThai ? "ไม่สามารถลองตอบคอมเมนต์ใหม่ได้" : "Unable to retry comment reply"));
      }

      await loadData(true);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : (isThai ? "ไม่สามารถลองตอบคอมเมนต์ใหม่ได้" : "Unable to retry comment reply"));
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="stack">
      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <h2>{isThai ? "โหมดตอบกลับอัตโนมัติ" : "Auto Reply Mode"}</h2>
          </div>
        </div>
        <form className="stack" onSubmit={handleSaveAutoConfig}>
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={autoConfig.autoCommentEnabled}
              onChange={(event) => setAutoConfig((current) => ({ ...current, autoCommentEnabled: event.target.checked }))}
            />
            <span>{isThai ? "ตอบกลับคอมเมนต์อัตโนมัติในเพจที่เลือก" : "Reply automatically to comments on selected pages"}</span>
          </label>

          <div className="stack">
            <strong>{isThai ? "เพจ Facebook" : "Facebook Pages"}</strong>
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
            {isThai ? "ชุดข้อความตอบกลับ" : "Reply library"}
            <div className="stack">
              {Array.from({ length: AUTO_COMMENT_REPLY_SLOTS }, (_, index) => (
                <input
                  key={`auto-reply-slot-${index}`}
                  value={autoConfig.autoCommentReplies[index] ?? ""}
                  onChange={(event) => updateAutoReplySlot(index, event.target.value)}
                  placeholder={isThai ? `คำตอบ ${index + 1}` : `Reply ${index + 1}`}
                />
              ))}
            </div>
          </label>

          <p style={{ color: "#64748b", margin: 0 }}>
            {isThai
              ? "เมื่อมีคอมเมนต์เข้ามาในเพจที่เลือก ระบบจะสุ่ม 1 คำตอบจากรายการนี้เพื่อนำไปตอบกลับ"
              : "When a comment arrives on one of these pages, the system will randomly choose one reply from this list."}
          </p>

          <button type="submit" className="button-primary" disabled={savingAutoConfig}>
            {savingAutoConfig ? (isThai ? "กำลังบันทึก..." : "Saving...") : isThai ? "บันทึกโหมดตอบกลับอัตโนมัติ" : "Save auto reply mode"}
          </button>
        </form>
      </section>

      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <h2>{isThai ? "ตั้งค่า Webhook" : "Webhook Setup"}</h2>
          </div>
          <button type="button" className="button-secondary" onClick={() => void loadData(true)} disabled={refreshing}>
            {refreshing ? (isThai ? "กำลังรีเฟรช..." : "Refreshing...") : isThai ? "รีเฟรช" : "Refresh"}
          </button>
        </div>
        <div className="stack">
          <p>{isThai ? "ใช้ URL นี้ใน Meta Webhooks สำหรับ event คอมเมนต์ของ Facebook Page" : "Use this URL in Meta Webhooks for Facebook Page comment events."}</p>
          <code>{webhookUrl}</code>
          <p>{isThai ? "Verify token: ตั้งค่า `FACEBOOK_WEBHOOK_VERIFY_TOKEN` ใน Vercel และใช้ค่าเดียวกันใน Meta" : "Verify token: set `FACEBOOK_WEBHOOK_VERIFY_TOKEN` in Vercel and use the same value in Meta."}</p>
        </div>
      </section>

      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <h2>{isThai ? "เช็กลิสต์ Meta Webhook" : "Meta Webhook Checklist"}</h2>
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
              <h2>{isThai ? "กล่องคอมเมนต์" : "Comment Inbox"}</h2>
            </div>
          </div>
          <div className="chip-grid">
            <span className="choice-chip active">{isThai ? "รับเข้าแล้ว" : "Received"} {commentSummary.received}</span>
            <span className="choice-chip active">{isThai ? "เข้าคิวแล้ว" : "Queued"} {commentSummary.queued}</span>
            <span className="choice-chip active">{isThai ? "ตอบแล้ว" : "Replied"} {commentSummary.replied}</span>
            <span className="choice-chip active">{isThai ? "ล้มเหลว" : "Failed"} {commentSummary.failed}</span>
          </div>
          <div className="stack">
            {loading ? <p>{isThai ? "กำลังโหลดคอมเมนต์..." : "Loading comments..."}</p> : null}
            {!loading && comments.length === 0 ? <p>{isThai ? "ยังไม่มีคอมเมนต์เข้าระบบ" : "No comments have been ingested yet."}</p> : null}
            {!loading
              ? comments.map((comment) => (
                  <article key={comment._id} className="card" style={{ padding: 16, gap: 10, display: "grid" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                      <strong>{comment.authorName}</strong>
                      <span className={`badge badge-${statusTone(comment.status)}`}>{comment.status}</span>
                    </div>
                    <div style={{ color: "#475569" }}>
                      <div>{isThai ? "เพจ" : "Page"}: {comment.pageId}</div>
                      {comment.matchedTrigger ? <div>{isThai ? "ทริกเกอร์ที่ตรง" : "Matched trigger"}: {comment.matchedTrigger}</div> : null}
                      {comment.matchedRuleType ? <div>{isThai ? "แหล่งคำตอบ" : "Reply source"}: {comment.matchedRuleType}</div> : null}
                      <div>{isThai ? "รหัสคอมเมนต์ภายนอก" : "External comment ID"}: {comment.externalCommentId || "-"}</div>
                    </div>
                    <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.message}</p>
                    <div className="card" style={{ padding: 12, background: "rgba(59,130,246,.05)" }}>
                      <strong style={{ display: "block", marginBottom: 6 }}>{isThai ? "สถานะการส่งตอบกลับ" : "Delivery status"}</strong>
                      <div style={{ color: "#475569", marginBottom: 8 }}>{getCommentProgressNote(comment, isThai)}</div>
                      <div style={{ display: "grid", gap: 4, color: "#64748b", fontSize: 13 }}>
                        <div>{isThai ? "รับเข้า" : "Received"}: {formatBangkokTime(comment.createdAt)}</div>
                        <div>{isThai ? "เข้าคิว" : "Queued"}: {formatBangkokTime(comment.queuedAt)}</div>
                        <div>{isThai ? "พยายามล่าสุด" : "Last attempt"}: {formatBangkokTime(comment.lastAttemptAt)}</div>
                        <div>{isThai ? "ตอบแล้ว" : "Replied"}: {formatBangkokTime(comment.repliedAt)}</div>
                        <div>{isThai ? "เปิด Auto Reply" : "Auto reply enabled"}: {comment.autoReplyEnabled ? (isThai ? "ใช่" : "Yes") : (isThai ? "ไม่" : "No")}</div>
                      </div>
                    </div>
                    {comment.replyText ? (
                      <div>
                        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>{isThai ? "ข้อความตอบกลับ" : "Reply"}</div>
                        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.replyText}</p>
                      </div>
                    ) : null}
                    {comment.replyError ? <div style={{ color: "#b91c1c" }}>{comment.replyError}</div> : null}
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                      <small style={{ color: "#64748b" }}>
                        {isThai ? "จำนวนครั้งที่ลอง" : "Attempts"}: {comment.replyAttempts ?? 0}
                      </small>
                      {(comment.status === "failed" || comment.status === "matched" || comment.status === "ignored") && comment.replyText && comment.externalCommentId ? (
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={retryingId === comment._id}
                          onClick={() => void handleRetry(comment._id)}
                        >
                          {retryingId === comment._id ? (isThai ? "กำลังลองใหม่..." : "Retrying...") : isThai ? "ลองตอบใหม่" : "Retry reply"}
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
              <h2>{isThai ? "กฎอัตโนมัติ" : "Automation Rules"}</h2>
            </div>
          </div>
          <div className="stack">
            <form className="stack" onSubmit={handleCreateGrowthRule}>
              <h3>{isThai ? "กฎเติบโต" : "Growth Rule"}</h3>
              <input
                value={growthForm.name}
                onChange={(event) => setGrowthForm((current) => ({ ...current, name: event.target.value }))}
                placeholder={isThai ? "ชื่อกฎ" : "Rule name"}
              />
              <input
                value={growthForm.triggerKeyword}
                onChange={(event) => setGrowthForm((current) => ({ ...current, triggerKeyword: event.target.value }))}
                placeholder={isThai ? "คีย์เวิร์ดกระตุ้น" : "Trigger keyword"}
              />
              <select
                value={growthForm.actionType}
                onChange={(event) => setGrowthForm((current) => ({ ...current, actionType: event.target.value as typeof current.actionType }))}
              >
                <option value="custom-reply">{isThai ? "ตอบกลับเอง" : "Custom reply"}</option>
                <option value="send-link">{isThai ? "ส่งลิงก์" : "Send link"}</option>
                <option value="invite-inbox">{isThai ? "ชวนเข้ากล่องข้อความ" : "Invite inbox"}</option>
              </select>
              <textarea
                value={growthForm.replyText}
                onChange={(event) => setGrowthForm((current) => ({ ...current, replyText: event.target.value }))}
                placeholder={isThai ? "ข้อความตอบกลับ" : "Reply text"}
                rows={4}
              />
              <button type="submit" className="button-primary" disabled={savingRule}>
                {savingRule ? (isThai ? "กำลังบันทึก..." : "Saving...") : isThai ? "บันทึกกฎเติบโต" : "Save growth rule"}
              </button>
            </form>

            <form className="stack" onSubmit={handleCreateKeywordTrigger}>
              <h3>{isThai ? "คีย์เวิร์ดทริกเกอร์" : "Keyword Trigger"}</h3>
              <input
                value={triggerForm.keyword}
                onChange={(event) => setTriggerForm((current) => ({ ...current, keyword: event.target.value }))}
                placeholder={isThai ? "คีย์เวิร์ด" : "Keyword"}
              />
              <input
                value={triggerForm.action}
                onChange={(event) => setTriggerForm((current) => ({ ...current, action: event.target.value }))}
                placeholder={isThai ? "ชื่อ action" : "Action label"}
              />
              <textarea
                value={triggerForm.replyText}
                onChange={(event) => setTriggerForm((current) => ({ ...current, replyText: event.target.value }))}
                placeholder={isThai ? "ข้อความตอบกลับ" : "Reply text"}
                rows={4}
              />
              <button type="submit" className="button-primary" disabled={savingTrigger}>
                {savingTrigger ? (isThai ? "กำลังบันทึก..." : "Saving...") : isThai ? "บันทึกคีย์เวิร์ดทริกเกอร์" : "Save keyword trigger"}
              </button>
            </form>

            <div className="stack">
              <h3>{isThai ? "กฎที่เปิดใช้งาน" : "Active rules"}</h3>
              {growthRules.length === 0 && keywordTriggers.length === 0 ? <p>{isThai ? "ยังไม่มีกฎ Auto Comment" : "No auto comment rules yet."}</p> : null}
              {growthRules.map((rule) => (
                <div key={rule._id} className="card" style={{ padding: 14 }}>
                  <strong>{rule.name}</strong>
                  <div style={{ color: "#64748b" }}>{isThai ? "คีย์เวิร์ด" : "Keyword"}: {rule.triggerKeyword}</div>
                  <div style={{ color: "#64748b" }}>{isThai ? "คำตอบ" : "Reply"}: {rule.replyText}</div>
                </div>
              ))}
              {keywordTriggers.map((trigger) => (
                <div key={trigger._id} className="card" style={{ padding: 14 }}>
                  <strong>{trigger.keyword}</strong>
                  <div style={{ color: "#64748b" }}>{isThai ? "Action" : "Action"}: {trigger.action}</div>
                  <div style={{ color: "#64748b" }}>{isThai ? "คำตอบ" : "Reply"}: {trigger.replyText || "-"}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
