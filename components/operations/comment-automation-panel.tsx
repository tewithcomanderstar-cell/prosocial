"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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

export function CommentAutomationPanel() {
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [growthRules, setGrowthRules] = useState<GrowthRule[]>([]);
  const [keywordTriggers, setKeywordTriggers] = useState<KeywordTrigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [growthForm, setGrowthForm] = useState(emptyGrowthRule);
  const [triggerForm, setTriggerForm] = useState(emptyKeywordTrigger);
  const [savingRule, setSavingRule] = useState(false);
  const [savingTrigger, setSavingTrigger] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

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

      const [commentsResponse, growthRulesResponse, triggersResponse] = await Promise.all([
        fetch("/api/comments", { credentials: "include" }),
        fetch("/api/growth-rules", { credentials: "include" }),
        fetch("/api/triggers", { credentials: "include" })
      ]);

      const [commentsPayload, growthRulesPayload, triggersPayload] = await Promise.all([
        commentsResponse.json(),
        growthRulesResponse.json(),
        triggersResponse.json()
      ]);

      if (!commentsResponse.ok) {
        throw new Error(commentsPayload.message || "Unable to load comments");
      }
      if (!growthRulesResponse.ok) {
        throw new Error(growthRulesPayload.message || "Unable to load growth rules");
      }
      if (!triggersResponse.ok) {
        throw new Error(triggersPayload.message || "Unable to load keyword triggers");
      }

      setComments(commentsPayload.data?.comments ?? []);
      setGrowthRules(growthRulesPayload.data?.rules ?? []);
      setKeywordTriggers((triggersPayload.data?.triggers ?? []).filter((item: KeywordTrigger) => item.triggerType === "comment"));
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
        throw new Error(payload.message || "Unable to save growth rule");
      }

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
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || "Unable to save keyword trigger");
      }

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
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || "Unable to retry comment reply");
      }

      await loadData(true);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Unable to retry comment reply");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="stack">
      <section className="card section-card">
        <div className="section-head">
          <div className="section-title-wrap">
            <h2>Webhook Setup</h2>
          </div>
          <button type="button" className="button-secondary" onClick={() => void loadData(true)} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="stack">
          <p>Use this URL in Meta Webhooks for Facebook Page comment events.</p>
          <code>{webhookUrl}</code>
          <p>Verify token: set `FACEBOOK_WEBHOOK_VERIFY_TOKEN` in Vercel and use the same value in Meta.</p>
        </div>
      </section>

      {error ? <div className="card" style={{ borderColor: "rgba(220,38,38,.25)", color: "#b91c1c" }}>{error}</div> : null}

      <div className="grid quick-grid" style={{ alignItems: "start" }}>
        <section className="card section-card">
          <div className="section-head">
            <div className="section-title-wrap">
              <h2>Comment Inbox</h2>
            </div>
          </div>
          <div className="stack">
            {loading ? <p>Loading comments...</p> : null}
            {!loading && comments.length === 0 ? <p>No comments have been ingested yet.</p> : null}
            {!loading
              ? comments.map((comment) => (
                  <article key={comment._id} className="card" style={{ padding: 16, gap: 10, display: "grid" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                      <strong>{comment.authorName}</strong>
                      <span className={`badge badge-${statusTone(comment.status)}`}>{comment.status}</span>
                    </div>
                    <div style={{ color: "#475569" }}>
                      <div>Page: {comment.pageId}</div>
                      {comment.matchedTrigger ? <div>Matched trigger: {comment.matchedTrigger}</div> : null}
                    </div>
                    <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.message}</p>
                    {comment.replyText ? (
                      <div>
                        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>Reply</div>
                        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{comment.replyText}</p>
                      </div>
                    ) : null}
                    {comment.replyError ? <div style={{ color: "#b91c1c" }}>{comment.replyError}</div> : null}
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                      <small style={{ color: "#64748b" }}>
                        Attempts: {comment.replyAttempts ?? 0}
                      </small>
                      {(comment.status === "failed" || comment.status === "matched" || comment.status === "ignored") && comment.replyText && comment.externalCommentId ? (
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={retryingId === comment._id}
                          onClick={() => void handleRetry(comment._id)}
                        >
                          {retryingId === comment._id ? "Retrying..." : "Retry reply"}
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
              <h2>Automation Rules</h2>
            </div>
          </div>
          <div className="stack">
            <form className="stack" onSubmit={handleCreateGrowthRule}>
              <h3>Growth Rule</h3>
              <input
                value={growthForm.name}
                onChange={(event) => setGrowthForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Rule name"
              />
              <input
                value={growthForm.triggerKeyword}
                onChange={(event) => setGrowthForm((current) => ({ ...current, triggerKeyword: event.target.value }))}
                placeholder="Trigger keyword"
              />
              <select
                value={growthForm.actionType}
                onChange={(event) => setGrowthForm((current) => ({ ...current, actionType: event.target.value as typeof current.actionType }))}
              >
                <option value="custom-reply">Custom reply</option>
                <option value="send-link">Send link</option>
                <option value="invite-inbox">Invite inbox</option>
              </select>
              <textarea
                value={growthForm.replyText}
                onChange={(event) => setGrowthForm((current) => ({ ...current, replyText: event.target.value }))}
                placeholder="Reply text"
                rows={4}
              />
              <button type="submit" className="button-primary" disabled={savingRule}>
                {savingRule ? "Saving..." : "Save growth rule"}
              </button>
            </form>

            <form className="stack" onSubmit={handleCreateKeywordTrigger}>
              <h3>Keyword Trigger</h3>
              <input
                value={triggerForm.keyword}
                onChange={(event) => setTriggerForm((current) => ({ ...current, keyword: event.target.value }))}
                placeholder="Keyword"
              />
              <input
                value={triggerForm.action}
                onChange={(event) => setTriggerForm((current) => ({ ...current, action: event.target.value }))}
                placeholder="Action label"
              />
              <textarea
                value={triggerForm.replyText}
                onChange={(event) => setTriggerForm((current) => ({ ...current, replyText: event.target.value }))}
                placeholder="Reply text"
                rows={4}
              />
              <button type="submit" className="button-primary" disabled={savingTrigger}>
                {savingTrigger ? "Saving..." : "Save keyword trigger"}
              </button>
            </form>

            <div className="stack">
              <h3>Active rules</h3>
              {growthRules.length === 0 && keywordTriggers.length === 0 ? <p>No auto comment rules yet.</p> : null}
              {growthRules.map((rule) => (
                <div key={rule._id} className="card" style={{ padding: 14 }}>
                  <strong>{rule.name}</strong>
                  <div style={{ color: "#64748b" }}>Keyword: {rule.triggerKeyword}</div>
                  <div style={{ color: "#64748b" }}>Reply: {rule.replyText}</div>
                </div>
              ))}
              {keywordTriggers.map((trigger) => (
                <div key={trigger._id} className="card" style={{ padding: 14 }}>
                  <strong>{trigger.keyword}</strong>
                  <div style={{ color: "#64748b" }}>Action: {trigger.action}</div>
                  <div style={{ color: "#64748b" }}>Reply: {trigger.replyText || "-"}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
