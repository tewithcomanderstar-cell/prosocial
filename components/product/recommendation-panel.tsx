"use client";

import { useEffect, useState } from "react";

type RecommendationData = {
  suggestions: string[];
  bestTimeToPost?: { hour: number; averageScore: number } | null;
};

type TrendData = {
  topics: Array<{ keyword: string; score: number; source: string }>;
  note: string;
};

export function RecommendationPanel() {
  const [recommendations, setRecommendations] = useState<RecommendationData | null>(null);
  const [trends, setTrends] = useState<TrendData | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/recommendations").then((res) => res.json()),
      fetch("/api/trends").then((res) => res.json())
    ]).then(([recRes, trendRes]) => {
      if (recRes.ok) setRecommendations(recRes.data);
      if (trendRes.ok) setTrends(trendRes.data);
    });
  }, []);

  return (
    <div className="grid cols-2">
      <section className="card">
        <div className="section-head"><div><h2>Suggestions</h2></div></div>
        <div className="list">
          {recommendations?.suggestions.map((item, index) => (
            <div key={index} className="list-item"><span>{item}</span></div>
          ))}
          {recommendations?.bestTimeToPost ? (
            <div className="list-item"><span>Best time</span><strong>{recommendations.bestTimeToPost.hour}:00</strong></div>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="section-head"><div><h2>Trends</h2></div></div>
        <div className="list">
          {trends?.topics.map((topic) => (
            <div key={topic.keyword} className="list-item">
              <div>
                <strong>{topic.keyword}</strong>
                <div className="muted">{topic.source}</div>
              </div>
              <span className="badge">{topic.score}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
