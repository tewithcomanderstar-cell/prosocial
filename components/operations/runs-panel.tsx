"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type RunItem = {
  id: string;
  workflowId: string;
  contentItemId?: string;
  triggerSource: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
};

type Summary = {
  totalRuns: number;
  pendingRuns: number;
  runningRuns: number;
  failedRuns: number;
  successRate: number;
};

export function RunsPanel() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  async function loadRuns() {
    const query = statusFilter === "all" ? "" : `?status=${encodeURIComponent(statusFilter)}`;
    const response = await fetch(`/api/runs${query}`);
    const payload = await response.json();
    if (payload.ok) {
      setRuns(payload.data.runs);
      setSummary(payload.data.summary);
    }
  }

  useEffect(() => {
    void loadRuns();
  }, [statusFilter]);

  const recentFailures = useMemo(() => runs.filter((run) => run.status === "failed").slice(0, 5), [runs]);

  async function retryRun(runId: string) {
    setRetryingId(runId);
    setFeedback(null);
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId })
    });
    const payload = await response.json();
    setRetryingId(null);
    setFeedback(payload.message || (payload.ok ? "Run queued for retry" : "Unable to retry run"));
    await loadRuns();
  }

  return (
    <div className="stack">
      {feedback ? <div className="composer-message">{feedback}</div> : null}

      <div className="grid cols-3">
        <div className="card stat stat-card"><strong>{summary?.totalRuns ?? 0}</strong><span>Total runs</span></div>
        <div className="card stat stat-card"><strong>{summary?.failedRuns ?? 0}</strong><span>Failed runs</span></div>
        <div className="card stat stat-card"><strong>{summary?.successRate ?? 0}%</strong><span>Success rate</span></div>
      </div>

      <section className="card stack">
        <div className="split">
          <div className="stack">
            <h3>Run history</h3>
            <span className="muted">Trace manual, scheduled, and retry execution outcomes.</span>
          </div>
          <select className="select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Trigger</th>
                <th>Content</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Recovery</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td><span className="badge badge-neutral">{run.status}</span></td>
                  <td>{run.triggerSource}</td>
                  <td className="muted">{run.contentItemId || "Ad hoc run"}</td>
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}</td>
                  <td>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "-"}</td>
                  <td>
                    <div className="split" style={{ gap: 8, justifyContent: "flex-start" }}>
                      <Link href={`/runs/${run.id}`} className="button-secondary">Inspect</Link>
                      {run.status === "failed" ? (
                        <button type="button" className="button-secondary" onClick={() => retryRun(run.id)} disabled={retryingId === run.id}>
                          {retryingId === run.id ? "Retrying..." : "Retry"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card stack">
        <div className="section-head"><div><h3>Recent failures</h3></div></div>
        <div className="list">
          {recentFailures.length ? recentFailures.map((run) => (
            <div key={run.id} className="list-item stack">
              <div className="split">
                <strong>{run.contentItemId || "Workflow run"}</strong>
                <span className="badge badge-neutral">{run.status}</span>
              </div>
              <div className="muted">{run.errorMessage || "No error details captured."}</div>
            </div>
          )) : <div className="list-item"><span className="muted">No failed runs in the current view.</span></div>}
        </div>
      </section>
    </div>
  );
}
