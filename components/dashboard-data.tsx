"use client";

import Link from "next/link";
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
    { label: t("dashConnectedPages"), value: summary.connectedPages, href: "/connections/facebook" },
    { label: t("dashPendingApprovals"), value: summary.pendingApprovals, href: "/approvals" },
    { label: t("dashFailedRuns"), value: summary.failedRuns, href: "/runs?status=failed" },
    { label: t("dashTokenWarnings"), value: summary.tokenWarnings, href: "/connections/facebook" }
  ];

  const secondaryStats = [
    { label: t("dashScheduledPosts"), value: summary.scheduledPosts, href: "/planner" },
    { label: t("dashRecurringPosts"), value: summary.recurringPosts, href: "/auto-post" },
    { label: t("dashOneTimePosts"), value: summary.oneTimePosts, href: "/posts/new" },
    { label: t("dashTotalPosts"), value: summary.totalPosts, href: "/queue" }
  ];

  const recommendedAction = summary.tokenWarnings > 0
    ? { label: t("dashReconnectDestinations"), href: "/connections/facebook" }
    : summary.failedRuns > 0
      ? { label: t("dashReviewFailedRuns"), href: "/runs?status=failed" }
      : { label: t("dashSystemHealthy"), href: "/dashboard" };

  return (
    <div className="stack">
      <div className="grid stats-grid">
        {primaryStats.map((stat) => (
          <Link key={stat.label} href={stat.href} className="card stat stat-card">
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </Link>
        ))}
      </div>

      <div className="grid stats-grid">
        {secondaryStats.map((stat) => (
          <Link key={stat.label} href={stat.href} className="card stat stat-card">
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </Link>
        ))}
      </div>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h3>{t("dashOperationalSnapshot")}</h3>
            <span className="muted">{t("dashOperationalSnapshotDesc")}</span>
          </div>
        </div>
        <div className="list">
          <div className="list-item"><span>{t("dashPublishingNow")}</span><strong>{summary.runningRuns}</strong></div>
          <div className="list-item"><span>{t("dashUnreadAlerts")}</span><strong>{summary.unreadAlerts}</strong></div>
          <div className="list-item"><span>{t("dashActiveConnections")}</span><strong>{summary.activeConnections}</strong></div>
          <div className="list-item"><span>{t("dashRecommendedAction")}</span><Link href={recommendedAction.href}><strong>{recommendedAction.label}</strong></Link></div>
        </div>
      </section>
    </div>
  );
}
