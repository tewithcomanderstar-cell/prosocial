"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

type RunDetail = {
  run: {
    id: string;
    workflowId: string;
    contentItemId?: string;
    triggerSource: string;
    status: RunStatus;
    startedAt?: string;
    finishedAt?: string;
    errorMessage?: string;
    inputJson?: Record<string, unknown>;
    outputJson?: Record<string, unknown>;
  };
  contentItem: {
    id: string;
    title: string;
    bodyText: string;
    status: string;
    destinationIds?: string[];
  } | null;
  timeline: Array<{
    id: string;
    level: string;
    type: string;
    message: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>;
  diagnostics: {
    attempts: number;
    maxAttempts: number;
    targetPageId?: string;
    fingerprint?: string;
  };
};

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function RunDetailPanel({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/runs/${runId}`)
      .then((res) => res.json())
      .then((payload) => {
        if (!payload.ok) {
          setError(payload.message || "Unable to load run details.");
          return;
        }
        setDetail(payload.data);
      })
      .catch(() => setError("Unable to load run details."));
  }, [runId]);

  if (error) {
    return <div className="card"><p className="muted">{error}</p></div>;
  }

  if (!detail) {
    return <div className="card"><p className="muted">Loading run details...</p></div>;
  }

  return (
    <div className="stack">
      <div className="grid cols-3">
        <div className="card stat stat-card"><strong>{detail.run.status}</strong><span>Run status</span></div>
        <div className="card stat stat-card"><strong>{detail.diagnostics.attempts}/{detail.diagnostics.maxAttempts}</strong><span>Attempts</span></div>
        <div className="card stat stat-card"><strong>{detail.timeline.length}</strong><span>Timeline events</span></div>
      </div>

      <section className="card stack">
        <div className="split">
          <div className="stack">
            <h3>Execution summary</h3>
            <span className="muted">Operational context for this automation run.</span>
          </div>
          <Link href="/runs" className="button-secondary">Back to runs</Link>
        </div>

        <div className="list">
          <div className="list-item"><span>Trigger source</span><strong>{detail.run.triggerSource}</strong></div>
          <div className="list-item"><span>Workflow</span><strong>{detail.run.workflowId}</strong></div>
          <div className="list-item"><span>Started</span><strong>{detail.run.startedAt ? new Date(detail.run.startedAt).toLocaleString() : "-"}</strong></div>
          <div className="list-item"><span>Finished</span><strong>{detail.run.finishedAt ? new Date(detail.run.finishedAt).toLocaleString() : "-"}</strong></div>
          <div className="list-item"><span>Target destination</span><strong>{detail.diagnostics.targetPageId || "-"}</strong></div>
          <div className="list-item"><span>Fingerprint</span><strong>{detail.diagnostics.fingerprint || "-"}</strong></div>
        </div>
        {detail.run.errorMessage ? <div className="composer-message composer-message-error">{detail.run.errorMessage}</div> : null}
      </section>

      <section className="card stack">
        <div className="section-head"><div><h3>Content snapshot</h3></div></div>
        {detail.contentItem ? (
          <div className="stack">
            <div className="list-item"><span>Title</span><strong>{detail.contentItem.title}</strong></div>
            <div className="list-item"><span>Status</span><strong>{detail.contentItem.status}</strong></div>
            <div className="list-item"><span>Destinations</span><strong>{detail.contentItem.destinationIds?.join(", ") || "-"}</strong></div>
            <div className="card" style={{ whiteSpace: "pre-wrap" }}>{detail.contentItem.bodyText || "No body text."}</div>
          </div>
        ) : (
          <div className="list-item"><span className="muted">No linked content item found for this run.</span></div>
        )}
      </section>

      <section className="card stack">
        <div className="section-head"><div><h3>Execution timeline</h3></div></div>
        <div className="list">
          {detail.timeline.length ? detail.timeline.map((event) => (
            <div key={event.id} className="list-item stack">
              <div className="split">
                <strong>{event.message}</strong>
                <span className="badge badge-neutral">{event.level}</span>
              </div>
              <span className="muted">{new Date(event.createdAt).toLocaleString()} · {event.type}</span>
            </div>
          )) : <div className="list-item"><span className="muted">No timeline events captured for this run yet.</span></div>}
        </div>
      </section>

      <div className="grid cols-2">
        <section className="card stack">
          <div className="section-head"><div><h3>Input snapshot</h3></div></div>
          <pre className="card" style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>{prettyJson(detail.run.inputJson)}</pre>
        </section>
        <section className="card stack">
          <div className="section-head"><div><h3>Output snapshot</h3></div></div>
          <pre className="card" style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>{prettyJson(detail.run.outputJson)}</pre>
        </section>
      </div>
    </div>
  );
}
