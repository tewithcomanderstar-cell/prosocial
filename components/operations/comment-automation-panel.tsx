"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppIcon } from "@/components/app-icon";

type CommentStatus =
  | "pending"
  | "matched"
  | "received"
  | "queued"
  | "processing"
  | "replying"
  | "replied"
  | "failed"
  | "ignored";

type CommentRecord = {
  _id: string;
  pageId: string;
  postId?: string;
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
  autoCommentAutoSyncEnabled: boolean;
  autoCommentIntervalMinutes: 15 | 30 | 60;
  autoCommentLastSyncedAt?: string | null;
  autoCommentPageIds: string[];
  autoCommentReplies: string[];
};

type FacebookPage = {
  pageId: string;
  name: string;
};

const AUTO_COMMENT_REPLY_SLOTS = 5;
const AUTO_SYNC_INTERVALS: Array<{ value: 15 | 30 | 60; label: string }> = [
  { value: 15, label: "ทุก 15 นาที" },
  { value: 30, label: "ทุก 30 นาที" },
  { value: 60, label: "ทุก 1 ชั่วโมง" }
];

function normalizeReplySlots(replies: string[]) {
  return Array.from({ length: AUTO_COMMENT_REPLY_SLOTS }, (_, index) => replies[index] ?? "");
}

function formatTimestamp(value?: string | null) {
  if (!value) return "-";

  return new Intl.DateTimeFormat("th-TH", {
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

function statusLabel(status: CommentStatus) {
  switch (status) {
    case "pending":
      return "รอรับเข้า";
    case "matched":
      return "เตรียมคำตอบแล้ว";
    case "received":
      return "รับเข้าแล้ว";
    case "queued":
      return "เข้าคิวแล้ว";
    case "processing":
      return "กำลังประมวลผล";
    case "replying":
      return "กำลังตอบกลับ";
    case "replied":
      return "ตอบแล้ว";
    case "failed":
      return "ล้มเหลว";
    case "ignored":
      return "ข้ามแล้ว";
    default:
      return status;
  }
}

function progressNote(status: CommentStatus) {
  switch (status) {
    case "pending":
      return "ระบบกำลังเตรียมรายการตอบกลับ";
    case "matched":
      return "ระบบเลือกคำตอบจาก Reply library แล้ว";
    case "received":
      return "ระบบดึงคอมเมนต์เข้ามาแล้ว";
    case "queued":
      return "รายการนี้เข้าคิวรอตอบแล้ว";
    case "processing":
      return "ระบบกำลังประมวลผลคอมเมนต์นี้";
    case "replying":
      return "ระบบกำลังส่งคำตอบกลับไปที่ Facebook";
    case "replied":
      return "ตอบคอมเมนต์สำเร็จแล้ว";
    case "failed":
      return "ตอบคอมเมนต์ไม่สำเร็จ สามารถลองใหม่ได้";
    case "ignored":
      return "รายการนี้ถูกข้าม";
    default:
      return "";
  }
}

export function CommentAutomationPanel() {
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [autoConfig, setAutoConfig] = useState<AutoCommentConfig>({
    autoCommentEnabled: false,
    autoCommentAutoSyncEnabled: false,
    autoCommentIntervalMinutes: 15,
    autoCommentLastSyncedAt: null,
    autoCommentPageIds: [],
    autoCommentReplies: normalizeReplySlots([])
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingAutoConfig, setSavingAutoConfig] = useState(false);
  const [syncingNow, setSyncingNow] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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

      if (!commentsResponse.ok) throw new Error(commentsPayload.message || "โหลด Comment Inbox ไม่สำเร็จ");
      if (!pagesResponse.ok) throw new Error(pagesPayload.message || "โหลดรายชื่อเพจไม่สำเร็จ");
      if (!autoConfigResponse.ok) throw new Error(autoConfigPayload.message || "โหลดการตั้งค่า Auto Comment ไม่สำเร็จ");

      setComments(commentsPayload.data?.comments ?? []);
      setPages(pagesPayload.data?.pages ?? []);
      setAutoConfig({
        autoCommentEnabled: Boolean(autoConfigPayload.data?.autoCommentEnabled),
        autoCommentAutoSyncEnabled: Boolean(autoConfigPayload.data?.autoCommentAutoSyncEnabled),
        autoCommentIntervalMinutes:
          autoConfigPayload.data?.autoCommentIntervalMinutes === 30 || autoConfigPayload.data?.autoCommentIntervalMinutes === 60
            ? autoConfigPayload.data.autoCommentIntervalMinutes
            : 15,
        autoCommentLastSyncedAt: autoConfigPayload.data?.autoCommentLastSyncedAt ?? null,
        autoCommentPageIds: autoConfigPayload.data?.autoCommentPageIds ?? [],
        autoCommentReplies: normalizeReplySlots(autoConfigPayload.data?.autoCommentReplies ?? [])
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลด Auto Comment ไม่สำเร็จ");
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
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/comments/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          autoCommentEnabled: autoConfig.autoCommentEnabled,
          autoCommentAutoSyncEnabled: autoConfig.autoCommentAutoSyncEnabled,
          autoCommentIntervalMinutes: autoConfig.autoCommentIntervalMinutes,
          autoCommentPageIds: autoConfig.autoCommentPageIds,
          autoCommentReplies: autoConfig.autoCommentReplies.map((item) => item.trim()).filter(Boolean),
          autoCommentPostIds: []
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "บันทึกการตั้งค่า Auto Comment ไม่สำเร็จ");
      setSuccessMessage("บันทึกโหมดตอบคอมเมนต์อัตโนมัติแล้ว");
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "บันทึกการตั้งค่า Auto Comment ไม่สำเร็จ");
    } finally {
      setSavingAutoConfig(false);
    }
  }

  async function handleSyncNow() {
    setSyncingNow(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/comments/sync", {
        method: "POST",
        credentials: "include"
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message || "ดึงโพสต์และคอมเมนต์อัตโนมัติไม่สำเร็จ");
      }

      const scannedPosts = Number(result.data?.totalScannedPosts ?? 0);
      const fetchedComments = Number(result.data?.totalFetchedComments ?? 0);
      const queuedReplies = Number(result.data?.totalQueuedReplies ?? 0);
      setSuccessMessage(`สแกนโพสต์ ${scannedPosts} รายการ, ดึงคอมเมนต์ ${fetchedComments} รายการ, เข้าคิวตอบ ${queuedReplies} รายการ`);
      await loadData(true);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "ดึงโพสต์และคอมเมนต์อัตโนมัติไม่สำเร็จ");
    } finally {
      setSyncingNow(false);
    }
  }

  async function handleRetry(commentId: string) {
    setRetryingId(commentId);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/comments/${commentId}/retry`, {
        method: "POST",
        credentials: "include"
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "ลองตอบคอมเมนต์ใหม่ไม่สำเร็จ");
      setSuccessMessage("ส่งรายการกลับเข้าคิวตอบคอมเมนต์แล้ว");
      await loadData(true);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "ลองตอบคอมเมนต์ใหม่ไม่สำเร็จ");
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
            <h2>โหมดตอบกลับอัตโนมัติ</h2>
          </div>
          <button type="button" className="button-secondary" onClick={() => void handleSyncNow()} disabled={syncingNow}>
            {syncingNow ? "กำลังดึงคอมเมนต์..." : "ดึงคอมเมนต์ตอนนี้"}
          </button>
        </div>

        <form className="stack" onSubmit={handleSaveAutoConfig}>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            ระบบจะสแกนโพสต์ล่าสุดของเพจที่เลือก หาโพสต์ที่มีคอมเมนต์ แล้วดึงคอมเมนต์เข้ามาใน inbox
            จากนั้นจะตอบกลับอัตโนมัติจาก Reply library ที่คุณตั้งไว้
          </p>

          <label style={{ display: "flex", gap: 12, alignItems: "center", fontWeight: 700 }}>
            <input
              type="checkbox"
              checked={autoConfig.autoCommentEnabled}
              onChange={(event) => setAutoConfig((current) => ({ ...current, autoCommentEnabled: event.target.checked }))}
            />
            <span>เปิดโหมดตอบคอมเมนต์อัตโนมัติสำหรับเพจที่เลือก</span>
          </label>

          <div className="card" style={{ padding: 16, background: "rgba(59,130,246,.05)", display: "grid", gap: 12 }}>
            <label style={{ display: "flex", gap: 12, alignItems: "center", fontWeight: 700 }}>
              <input
                type="checkbox"
                checked={autoConfig.autoCommentAutoSyncEnabled}
                onChange={(event) =>
                  setAutoConfig((current) => ({
                    ...current,
                    autoCommentAutoSyncEnabled: event.target.checked
                  }))
                }
              />
              <span>ดึงคอมเมนต์ออโต้</span>
            </label>

            <div className="stack">
              <strong>ช่วงเวลาการดึงคอมเมนต์อัตโนมัติ</strong>
              <div className="chip-grid">
                {AUTO_SYNC_INTERVALS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`choice-chip ${autoConfig.autoCommentIntervalMinutes === option.value ? "active" : ""}`}
                    onClick={() =>
                      setAutoConfig((current) => ({
                        ...current,
                        autoCommentIntervalMinutes: option.value
                      }))
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small style={{ color: "var(--muted)" }}>
                รอบอัตโนมัติจะใช้ cron กลางของระบบทุก 5 นาทีเป็นตัวปลุก แล้วจะสแกนจริงตามช่วงเวลา 15 นาที, 30 นาที หรือ 1 ชั่วโมงที่คุณเลือกไว้
              </small>
              <small style={{ color: "var(--muted)" }}>
                ดึงคอมเมนต์ล่าสุด: {formatTimestamp(autoConfig.autoCommentLastSyncedAt)}
              </small>
            </div>
          </div>

          <div className="stack">
            <strong>เลือกเพจ Facebook</strong>
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

          <div className="card" style={{ padding: 16, background: "rgba(59,130,246,.05)" }}>
            <strong style={{ display: "block", marginBottom: 8 }}>ระบบดึงโพสต์ให้อัตโนมัติ</strong>
            <p style={{ margin: 0, color: "#475569" }}>
              ไม่ต้องใส่ post_id เองแล้ว ระบบจะดูโพสต์ล่าสุดของเพจที่เลือก และหยิบเฉพาะโพสต์ที่มีคอมเมนต์เข้ามาประมวลผล
            </p>
          </div>

          <label className="label">
            <span>Reply library</span>
            <div className="stack">
              {normalizeReplySlots(autoConfig.autoCommentReplies).map((value, index) => (
                <input
                  key={`reply-slot-${index}`}
                  className="input"
                  value={value}
                  onChange={(event) => updateAutoReplySlot(index, event.target.value)}
                  placeholder={`คำตอบ ${index + 1}`}
                />
              ))}
            </div>
          </label>

          <button type="submit" className="button" disabled={savingAutoConfig}>
            {savingAutoConfig ? "กำลังบันทึก..." : "บันทึกโหมดตอบกลับอัตโนมัติ"}
          </button>
        </form>
      </section>

      {error ? (
        <div className="card" style={{ borderColor: "rgba(220,38,38,.25)", color: "#b91c1c" }}>
          {error}
        </div>
      ) : null}

      {successMessage ? (
        <div className="card" style={{ borderColor: "rgba(34,197,94,.25)", color: "#166534" }}>
          {successMessage}
        </div>
      ) : null}

      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <AppIcon name="bulk" className="section-icon" />
            <h2>Comment Inbox</h2>
          </div>
          <button type="button" className="button-secondary" onClick={() => void loadData(true)} disabled={refreshing}>
            {refreshing ? "กำลังรีเฟรช..." : "รีเฟรช"}
          </button>
        </div>

        <div className="chip-grid">
          <span className="choice-chip active">รับเข้าแล้ว {commentSummary.received}</span>
          <span className="choice-chip active">เข้าคิวแล้ว {commentSummary.queued}</span>
          <span className="choice-chip active">ตอบแล้ว {commentSummary.replied}</span>
          <span className="choice-chip active">ล้มเหลว {commentSummary.failed}</span>
        </div>

        <div className="stack">
          {loading ? <p>กำลังโหลดคอมเมนต์...</p> : null}
          {!loading && comments.length === 0 ? <p>ยังไม่มีคอมเมนต์เข้า inbox</p> : null}
          {!loading
            ? comments.map((comment) => (
                <article key={comment._id} className="card" style={{ padding: 16, gap: 10, display: "grid" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <strong>{comment.authorName}</strong>
                    <span className={`badge badge-${statusTone(comment.status)}`}>{statusLabel(comment.status)}</span>
                  </div>

                  <div style={{ color: "#475569", display: "grid", gap: 4 }}>
                    <div>เพจ: {comment.pageId}</div>
                    <div>Post ID: {comment.postId || "-"}</div>
                    <div>Comment ID: {comment.externalCommentId || "-"}</div>
                  </div>

                  <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.message}</p>

                  <div className="card" style={{ padding: 12, background: "rgba(59,130,246,.05)" }}>
                    <strong style={{ display: "block", marginBottom: 6 }}>สถานะการตอบกลับ</strong>
                    <div style={{ color: "#475569", marginBottom: 8 }}>{progressNote(comment.status)}</div>
                    <div style={{ display: "grid", gap: 4, color: "#64748b", fontSize: 13 }}>
                      <div>รับเข้า: {formatTimestamp(comment.createdAt)}</div>
                      <div>เข้าคิว: {formatTimestamp(comment.queuedAt)}</div>
                      <div>พยายามล่าสุด: {formatTimestamp(comment.lastAttemptAt)}</div>
                      <div>ตอบแล้ว: {formatTimestamp(comment.repliedAt)}</div>
                    </div>
                  </div>

                  {comment.replyText ? (
                    <div>
                      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>ข้อความตอบกลับ</div>
                      <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.replyText}</p>
                    </div>
                  ) : null}

                  {comment.replyError ? <div style={{ color: "#b91c1c" }}>{comment.replyError}</div> : null}

                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <small style={{ color: "#64748b" }}>จำนวนครั้งที่ลอง: {comment.replyAttempts ?? 0}</small>
                    {comment.status === "failed" && comment.replyText && comment.externalCommentId ? (
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={retryingId === comment._id}
                        onClick={() => void handleRetry(comment._id)}
                      >
                        {retryingId === comment._id ? "กำลังลองใหม่..." : "ลองตอบใหม่"}
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
