"use client";

import { useEffect, useMemo, useState } from "react";

type QueueItem = {
  id: string;
  title: string;
  bodyText: string;
  status: string;
  scheduledAt?: string;
  publishedAt?: string;
  destinationIds?: string[];
  approvalRequired?: boolean;
};

type Summary = {
  total: number;
  draft: number;
  pendingReview: number;
  approved: number;
  scheduled: number;
  publishing: number;
  failed: number;
};

export function QueuePanel() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function loadQueue() {
    const query = statusFilter === "all" ? "" : `?status=${encodeURIComponent(statusFilter)}`;
    const response = await fetch(`/api/queue${query}`);
    const payload = await response.json();
    if (payload.ok) {
      setItems(payload.data.items);
      setSummary(payload.data.summary);
      setSelectedIds((current) => current.filter((id) => payload.data.items.some((item: QueueItem) => item.id === id)));
    }
  }

  useEffect(() => {
    void loadQueue();
  }, [statusFilter]);

  const sortedItems = useMemo(
    () =>
      [...items].sort((left, right) => {
        const leftDate = left.scheduledAt ? new Date(left.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
        const rightDate = right.scheduledAt ? new Date(right.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
        return leftDate - rightDate;
      }),
    [items]
  );

  function toggleSelection(id: string) {
    setSelectedIds((current) => (current.includes(id) ? current.filter((currentId) => currentId !== id) : [...current, id]));
  }

  async function applyBulkAction(action: "move_to_draft" | "retry" | "approve") {
    if (!selectedIds.length) return;
    const response = await fetch("/api/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: selectedIds, action })
    });
    const payload = await response.json();
    setFeedback(payload.message || (payload.ok ? "Queue updated" : "Unable to update queue"));
    await loadQueue();
  }

  return (
    <div className="stack">
      {feedback ? <div className="composer-message">{feedback}</div> : null}

      <div className="grid cols-3">
        <div className="card stat stat-card"><strong>{summary?.total ?? 0}</strong><span>Total items</span></div>
        <div className="card stat stat-card"><strong>{summary?.pendingReview ?? 0}</strong><span>Pending review</span></div>
        <div className="card stat stat-card"><strong>{summary?.failed ?? 0}</strong><span>Failed items</span></div>
      </div>

      <section className="card stack">
        <div className="split">
          <div className="stack">
            <h3>Content queue</h3>
            <span className="muted">Review upcoming content, unblock failed publishes, and approve items in bulk.</span>
          </div>
          <select className="select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="pending_review">Pending review</option>
            <option value="approved">Approved</option>
            <option value="scheduled">Scheduled</option>
            <option value="publishing">Publishing</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        <div className="composer-actions">
          <button type="button" className="button-secondary" onClick={() => applyBulkAction("approve")} disabled={!selectedIds.length}>
            Bulk approve
          </button>
          <button type="button" className="button-secondary" onClick={() => applyBulkAction("retry")} disabled={!selectedIds.length}>
            Bulk retry
          </button>
          <button type="button" className="button-secondary" onClick={() => applyBulkAction("move_to_draft")} disabled={!selectedIds.length}>
            Move to draft
          </button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Title</th>
                <th>Status</th>
                <th>Destinations</th>
                <th>Scheduled</th>
                <th>Published</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} />
                  </td>
                  <td>
                    <div className="stack">
                      <strong>{item.title}</strong>
                      <span className="muted">{item.bodyText.slice(0, 90) || "No body text"}</span>
                    </div>
                  </td>
                  <td><span className="badge badge-neutral">{item.status}</span></td>
                  <td className="muted">{item.destinationIds?.length || 0}</td>
                  <td>{item.scheduledAt ? new Date(item.scheduledAt).toLocaleString() : "-"}</td>
                  <td>{item.publishedAt ? new Date(item.publishedAt).toLocaleString() : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
