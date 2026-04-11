"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/language-provider";

type Summary = {
  totalPosts: number;
  scheduledPosts: number;
  recurringPosts: number;
  oneTimePosts: number;
  pendingApprovals: number;
  failedRuns: number;
  runningRuns: number;
  unreadAlerts: number;
  connectedPages: number;
  tokenWarnings: number;
  activeConnections: number;
};

export function DashboardData() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/summary")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setSummary(result.data);
          return;
        }

        setError(t("dashLoginNeeded"));
      })
      .catch(() => setError(t("dashLoadError")));
  }, [t]);

  if (error) {
    return (
      <div className="card">
        <p className="muted">{error}</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="card">
        <p className="muted">{t("commonLoading")}</p>
      </div>
    );
  }

  const primaryStats = [
    { label: "Connected pages", value: summary.connectedPages },
    { label: "Pending approvals", value: summary.pendingApprovals },
    { label: "Failed runs", value: summary.failedRuns },
    { label: "Token warnings", value: summary.tokenWarnings }
  ];

  const secondaryStats = [
    { label: t("dashScheduledPosts"), value: summary.scheduledPosts },
    { label: t("dashRecurringPosts"), value: summary.recurringPosts },
    { label: t("dashOneTimePosts"), value: summary.oneTimePosts },
    { label: t("dashTotalPosts"), value: summary.totalPosts }
  ];

  const recommendedAction = summary.tokenWarnings > 0
    ? "Reconnect destinations with token warnings"
    : summary.failedRuns > 0
      ? "Review failed runs and retry"
      : "System healthy";

  return (
    <div className="stack">
      <div className="grid stats-grid">
        {primaryStats.map((stat) => (
          <div key={stat.label} className="card stat stat-card">
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </div>
        ))}
      </div>

      <div className="grid stats-grid">
        {secondaryStats.map((stat) => (
          <div key={stat.label} className="card stat stat-card">
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </div>
        ))}
      </div>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h3>Operational snapshot</h3>
            <span className="muted">A quick read on queue pressure, workflow health, and connector readiness.</span>
          </div>
        </div>
        <div className="list">
          <div className="list-item"><span>Publishing now</span><strong>{summary.runningRuns}</strong></div>
          <div className="list-item"><span>Unread alerts</span><strong>{summary.unreadAlerts}</strong></div>
          <div className="list-item"><span>Active connections</span><strong>{summary.activeConnections}</strong></div>
          <div className="list-item"><span>Recommended action</span><strong>{recommendedAction}</strong></div>
        </div>
      </section>
    </div>
  );
}
