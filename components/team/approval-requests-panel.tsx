"use client";

import { useEffect, useState } from "react";

type ApprovalItem = {
  id: string;
  contentItemId: string;
  contentTitle: string;
  requestedBy: string;
  assignedTo?: string;
  status: "pending" | "approved" | "rejected" | "changes_requested";
  comment?: string;
  decidedAt?: string;
};

type Summary = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
};

export function ApprovalRequestsPanel() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  async function loadItems() {
    const response = await fetch("/api/approval-requests");
    const payload = await response.json();
    if (payload.ok) {
      setItems(payload.data.items);
      setSummary(payload.data.summary);
    }
  }

  useEffect(() => {
    void loadItems();
  }, []);

  async function updateStatus(id: string, status: "approved" | "rejected") {
    setSubmittingId(id);
    const response = await fetch("/api/approval-requests", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        status,
        comment: status === "approved" ? "Approved from inbox" : "Rejected from inbox"
      })
    });
    const payload = await response.json();
    setSubmittingId(null);
    setFeedback(payload.message || (payload.ok ? "Approval updated" : "Unable to update approval"));
    await loadItems();
  }

  return (
    <div className="stack">
      {feedback ? <div className="composer-message">{feedback}</div> : null}

      <div className="grid cols-3">
        <div className="card stat stat-card"><strong>{summary?.total ?? 0}</strong><span>Total requests</span></div>
        <div className="card stat stat-card"><strong>{summary?.pending ?? 0}</strong><span>Pending</span></div>
        <div className="card stat stat-card"><strong>{summary?.approved ?? 0}</strong><span>Approved</span></div>
      </div>

      <section className="card stack">
        <div className="section-head"><div><h3>Approval inbox</h3></div></div>
        <div className="list">
          {items.map((item) => (
            <div key={item.id} className="list-item stack">
              <div className="split">
                <div className="stack">
                  <strong>{item.contentTitle}</strong>
                  <span className="muted">Content ID: {item.contentItemId}</span>
                </div>
                <span className="badge badge-neutral">{item.status}</span>
              </div>
              <div className="muted">{item.comment || "No reviewer note yet."}</div>
              <div className="split">
                <span className="muted">
                  {item.decidedAt ? `Updated ${new Date(item.decidedAt).toLocaleString()}` : "Awaiting decision"}
                </span>
                {item.status === "pending" ? (
                  <div className="composer-actions">
                    <button type="button" className="button-secondary" disabled={submittingId === item.id} onClick={() => updateStatus(item.id, "approved")}>
                      {submittingId === item.id ? "Working..." : "Approve"}
                    </button>
                    <button type="button" className="button-secondary danger-button" disabled={submittingId === item.id} onClick={() => updateStatus(item.id, "rejected")}>
                      {submittingId === item.id ? "Working..." : "Reject"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
