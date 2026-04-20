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
  autoCommentPageIds: string[];
  autoCommentPostIds: string[];
  autoCommentReplies: string[];
};

type FacebookPage = {
  pageId: string;
  name: string;
};

const AUTO_COMMENT_REPLY_SLOTS = 5;

function normalizeReplySlots(replies: string[]) {
  return Array.from({ length: AUTO_COMMENT_REPLY_SLOTS }, (_, index) => replies[index] ?? "");
}

function normalizePostIds(postIds: string) {
  return Array.from(
    new Set(
      postIds
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function formatTimestamp(value?: string) {
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
      return "เลือกคำตอบจาก Reply library แล้ว";
    case "received":
      return "ระบบดึงคอมเมนต์เข้ามาแล้ว";
    case "queued":
      return "รายการนี้เข้าแถวรอตอบแล้ว";
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
    autoCommentPageIds: [],
    autoCommentPostIds: [],
    autoCommentReplies: normalizeReplySlots([])
  });
  const [postIdsInput, setPostIdsInput] = useState("");
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
        autoCommentPageIds: autoConfigPayload.data?.autoCommentPageIds ?? [],
        autoCommentPostIds: autoConfigPayload.data?.autoCommentPostIds ?? [],
        autoCommentReplies: normalizeReplySlots(autoConfigPayload.data?.autoCommentReplies ?? [])
      });
      setPostIdsInput((autoConfigPayload.data?.autoCommentPostIds ?? []).join("\n"));
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
          autoCommentPageIds: autoConfig.autoCommentPageIds,
          autoCommentPostIds: normalizePostIds(postIdsInput),
          autoCommentReplies: autoConfig.autoCommentReplies.map((item) => item.trim()).filter(Boolean)
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
        throw new Error(result.message || "ดึงคอมเมนต์จาก post_id ไม่สำเร็จ");
      }

      const fetched = Number(result.data?.totalFetchedComments ?? 0);
      const queued = Number(result.data?.totalQueuedReplies ?? 0);
      const removed = Number(result.data?.totalRemovedPostIds ?? 0);
      setSuccessMessage(`ดึงคอมเมนต์แล้ว ${fetched} รายการ, เข้าคิวตอบ ${queued} รายการ, ปิดงาน post_id ${removed} รายการ`);
      await loadData(true);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "ดึงคอมเมนต์จาก post_id ไม่สำเร็จ");
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
            ระบบจะใช้ <strong>post_id</strong> ที่คุณใส่ไว้เป็นตัวดึงคอมเมนต์จาก Facebook จากนั้นจะบันทึกลง inbox
            และไล่ตอบทีละคอมเมนต์จนจบงานของโพสต์นั้น
          </p>

          <label style={{ display: "flex", gap: 12, alignItems: "center", fontWeight: 700 }}>
            <input
              type="checkbox"
              checked={autoConfig.autoCommentEnabled}
              onChange={(event) => setAutoConfig((current) => ({ ...current, autoCommentEnabled: event.target.checked }))}
            />
            <span>เปิดโหมดตอบคอมเมนต์อัตโนมัติสำหรับเพจที่เลือก</span>
          </label>

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

          <label className="label">
            <span>Post ID ที่ต้องการติดตาม</span>
            <textarea
              className="input"
              rows={5}
              value={postIdsInput}
              onChange={(event) => setPostIdsInput(event.target.value)}
              placeholder={"ใส่ post_id ทีละ 1 บรรทัด\nตัวอย่าง: 123456789012345_987654321098765"}
            />
            <small style={{ color: "var(--muted)" }}>
              ใส่ 1 post_id ต่อ 1 บรรทัด ระบบจะดึงคอมเมนต์จากโพสต์เหล่านี้ทุกครั้งที่รอบ sync ทำงาน และจะถอด post_id
              ออกจากระบบเมื่อคอมเมนต์ของโพสต์นั้นตอบครบแล้ว
            </small>
          </label>

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
