"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/language-provider";

type Summary = {
  totalPosts: number;
  scheduledPosts: number;
  recurringPosts: number;
  oneTimePosts: number;
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

  const stats = [
    { label: t("dashScheduledPosts"), value: summary.scheduledPosts },
    { label: t("dashRecurringPosts"), value: summary.recurringPosts },
    { label: t("dashOneTimePosts"), value: summary.oneTimePosts },
    { label: t("dashTotalPosts"), value: summary.totalPosts }
  ];

  return (
    <div className="grid stats-grid">
      {stats.map((stat) => (
        <div key={stat.label} className="card stat stat-card">
          <strong>{stat.value}</strong>
          <span>{stat.label}</span>
        </div>
      ))}
    </div>
  );
}
