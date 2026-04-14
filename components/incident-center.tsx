"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Incident = {
  id: string;
  severity: "info" | "warn" | "error";
  title: string;
  rootCause: string;
  source: string;
  fingerprint: string;
  affectedPosts: string[];
  affectedPages: string[];
  occurrences: number;
  latestAt: string;
  suggestedFix: string;
  action: {
    label: string;
    href?: string;
  };
  samples: string[];
};

type Summary = {
  total: number;
  critical: number;
  warnings: number;
  sources: string[];
  top: Incident[];
};

function badgeClass(severity: "info" | "warn" | "error") {
  if (severity === "error") return "badge badge-warn";
  if (severity === "warn") return "badge badge-info";
  return "badge badge-neutral";
}

export function IncidentCenter() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState("all");
  const [source, setSource] = useState("all");
  const [message, setMessage] = useState("");

  async function loadData(nextSeverity = severity, nextSource = source) {
    setLoading(true);
    const [summaryRes, incidentsRes] = await Promise.all([
      fetch("/api/incidents/summary", { cache: "no-store", credentials: "include" }).then((res) => res.json()),
      fetch(
        `/api/incidents?severity=${encodeURIComponent(nextSeverity)}&source=${encodeURIComponent(nextSource)}`,
        { cache: "no-store", credentials: "include" }
      ).then((res) => res.json())
    ]);
    setLoading(false);

    if (summaryRes.ok) {
      setSummary(summaryRes.data);
    }

    if (incidentsRes.ok) {
      setIncidents(incidentsRes.data.incidents);
      setMessage("");
    } else {
      setMessage(incidentsRes.message || "Unable to load incidents.");
    }
  }

  useEffect(() => {
    loadData("all", "all");
  }, []);

  const sourceOptions = useMemo(() => ["all", ...(summary?.sources || [])], [summary]);

  return (
    <div className="stack page-stack">
      <div className="grid cols-3">
        <div className="card stat stat-card">
          <strong>{summary?.total ?? 0}</strong>
          <span>Grouped incidents</span>
        </div>
        <div className="card stat stat-card">
          <strong>{summary?.critical ?? 0}</strong>
          <span>Critical issues</span>
        </div>
        <div className="card stat stat-card">
          <strong>{summary?.warnings ?? 0}</strong>
          <span>Warnings</span>
        </div>
      </div>

      <section className="card stack">
        <div className="split" style={{ alignItems: "center" }}>
          <div className="stack" style={{ gap: 4 }}>
            <h2>Error Center</h2>
            <span className="muted">Turn raw logs into human-readable issues with suggested fixes and one-click actions.</span>
          </div>
          <button className="button-secondary" type="button" onClick={() => loadData()}>
            Refresh
          </button>
        </div>

        <div className="grid cols-2">
          <label className="label">
            Severity
            <select
              className="select"
              value={severity}
              onChange={(event) => {
                const next = event.target.value;
                setSeverity(next);
                loadData(next, source);
              }}
            >
              <option value="all">All severities</option>
              <option value="error">Critical only</option>
              <option value="warn">Warnings only</option>
            </select>
          </label>

          <label className="label">
            Source
            <select
              className="select"
              value={source}
              onChange={(event) => {
                const next = event.target.value;
                setSource(next);
                loadData(severity, next);
              }}
            >
              {sourceOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All sources" : option}
                </option>
              ))}
            </select>
          </label>
        </div>

        {message ? <div className="composer-message composer-message-error">{message}</div> : null}

        {loading ? <p className="muted">Loading incidents...</p> : null}

        <div className="list">
          {!loading && incidents.length === 0 ? (
            <div className="list-item">
              <strong>No incidents found for this filter.</strong>
            </div>
          ) : null}

          {incidents.map((incident) => (
            <article key={incident.id} className="list-item" style={{ alignItems: "stretch" }}>
              <div className="stack" style={{ gap: 10, flex: 1 }}>
                <div className="split">
                  <div className="stack" style={{ gap: 4 }}>
                    <strong>{incident.title}</strong>
                    <span className="muted">{incident.rootCause}</span>
                  </div>
                  <span className={badgeClass(incident.severity)}>{incident.severity}</span>
                </div>

                <div className="grid cols-2" style={{ gap: 12 }}>
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="muted">Affected posts</span>
                    <strong>{incident.affectedPosts.length || 0}</strong>
                  </div>
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="muted">Affected pages</span>
                    <strong>{incident.affectedPages.length || 0}</strong>
                  </div>
                </div>

                <div className="stack" style={{ gap: 4 }}>
                  <span className="muted">Suggested fix</span>
                  <strong>{incident.suggestedFix}</strong>
                </div>

                <div className="split">
                  <span className="muted">
                    {incident.occurrences} occurrence{incident.occurrences === 1 ? "" : "s"} · last seen{" "}
                    {new Date(incident.latestAt).toLocaleString()}
                  </span>
                  {incident.action.href ? (
                    <Link className="button-secondary" href={incident.action.href}>
                      {incident.action.label}
                    </Link>
                  ) : (
                    <span className="badge badge-neutral">{incident.action.label}</span>
                  )}
                </div>

                {incident.samples.length > 0 ? (
                  <details>
                    <summary>View grouped samples</summary>
                    <ul className="list" style={{ marginTop: 10 }}>
                      {incident.samples.slice(0, 3).map((sample) => (
                        <li key={sample} className="list-item">
                          <span className="muted">{sample}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
