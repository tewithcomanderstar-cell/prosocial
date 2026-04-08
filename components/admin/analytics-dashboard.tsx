"use client";

import { useEffect, useState } from "react";

type AnalyticsOverview = {
  totalPosts: number;
  totals: { likes: number; comments: number; shares: number; impressions: number };
  averageEngagement: number;
  bestPost?: { pageId?: string; engagementScore?: number; publishedAt?: string } | null;
  bestHour?: { hour: number; averageScore: number } | null;
  recentMetrics: Array<{
    _id: string;
    likes: number;
    comments: number;
    shares: number;
    engagementScore: number;
    publishedAt: string;
    pageId?: string;
  }>;
};

export function AnalyticsDashboard() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);

  useEffect(() => {
    fetch("/api/analytics/overview")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setOverview(result.data);
        }
      });
  }, []);

  if (!overview) {
    return <div className="card"><p className="muted">Loading analytics...</p></div>;
  }

  return (
    <div className="stack">
      <div className="grid cols-3">
        <div className="card stat stat-card">
          <strong>{overview.totals.likes}</strong>
          <span>Likes</span>
        </div>
        <div className="card stat stat-card">
          <strong>{overview.totals.comments}</strong>
          <span>Comments</span>
        </div>
        <div className="card stat stat-card">
          <strong>{overview.totals.shares}</strong>
          <span>Shares</span>
        </div>
      </div>

      <div className="grid cols-2">
        <section className="card">
          <div className="section-head"><div><h2>Overview</h2></div></div>
          <div className="list">
            <div className="list-item"><span>Tracked posts</span><strong>{overview.totalPosts}</strong></div>
            <div className="list-item"><span>Average engagement score</span><strong>{overview.averageEngagement}</strong></div>
            <div className="list-item"><span>Best posting hour</span><strong>{overview.bestHour ? `${overview.bestHour.hour}:00` : "N/A"}</strong></div>
            <div className="list-item"><span>Best average score</span><strong>{overview.bestHour ? overview.bestHour.averageScore.toFixed(2) : "0.00"}</strong></div>
          </div>
        </section>

        <section className="card">
          <div className="section-head"><div><h2>Best Post</h2></div></div>
          <div className="list">
            <div className="list-item"><span>Page</span><strong>{overview.bestPost?.pageId ?? "N/A"}</strong></div>
            <div className="list-item"><span>Score</span><strong>{overview.bestPost?.engagementScore ?? 0}</strong></div>
            <div className="list-item"><span>Published</span><strong>{overview.bestPost?.publishedAt ? new Date(overview.bestPost.publishedAt).toLocaleString() : "N/A"}</strong></div>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="section-head"><div><h2>Recent Metrics</h2></div></div>
        <div className="list">
          {overview.recentMetrics.map((metric) => (
            <div key={metric._id} className="list-item">
              <div>
                <strong>{metric.pageId ?? "Unknown page"}</strong>
                <div className="muted">Likes {metric.likes} · Comments {metric.comments} · Shares {metric.shares}</div>
              </div>
              <span className="muted">Score {metric.engagementScore.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
