"use client";

import { useEffect, useMemo, useState } from "react";

type PlannerItem = {
  id: string;
  title: string;
  caption: string;
  imageUrls: string[];
  status: string;
  approvalStatus: string;
  localTime: string;
  bucket: string;
};

export function PlannerBoard() {
  const [view, setView] = useState<"day" | "week" | "month">("week");
  const [items, setItems] = useState<PlannerItem[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function load(selectedView = view) {
    const response = await fetch(`/api/planner?view=${selectedView}`);
    const result = await response.json();
    if (result.ok) {
      setItems(result.data.items);
    }
  }

  useEffect(() => {
    load(view);
  }, [view]);

  const buckets = useMemo(() => Array.from(new Set(items.map((item) => item.bucket))), [items]);

  async function moveItem(scheduleId: string, bucket: string) {
    const target = items.find((item) => item.id === scheduleId);
    if (!target) {
      return;
    }

    const nextRunAt = new Date();
    if (view === "day") {
      const [hour] = bucket.split(":");
      nextRunAt.setHours(Number(hour), 0, 0, 0);
    } else {
      nextRunAt.setHours(nextRunAt.getHours() + 24, 0, 0, 0);
    }

    const response = await fetch(`/api/schedules/${scheduleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nextRunAt: nextRunAt.toISOString() })
    });
    const result = await response.json();
    setMessage(result.message || "Updated");
    if (result.ok) {
      load(view);
    }
  }

  return (
    <div className="stack">
      <div className="split">
        <div className="hero-panel">
          <button className={view === "day" ? "button" : "button-secondary"} type="button" onClick={() => setView("day")}>Day</button>
          <button className={view === "week" ? "button" : "button-secondary"} type="button" onClick={() => setView("week")}>Week</button>
          <button className={view === "month" ? "button" : "button-secondary"} type="button" onClick={() => setView("month")}>Month</button>
        </div>
        {message ? <span className="muted">{message}</span> : null}
      </div>

      <div className="planner-grid">
        {buckets.map((bucket) => (
          <section
            key={bucket}
            className="card planner-column"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragId) {
                moveItem(dragId, bucket);
                setDragId(null);
              }
            }}
          >
            <div className="section-head">
              <div>
                <h2>{bucket}</h2>
              </div>
            </div>
            <div className="stack">
              {items.filter((item) => item.bucket === bucket).map((item) => (
                <article key={item.id} className="variant planner-card" draggable onDragStart={() => setDragId(item.id)}>
                  <strong>{item.title}</strong>
                  {item.caption ? <p>{item.caption.slice(0, 120)}</p> : null}
                  {item.imageUrls[0] ? <div className="planner-thumb" style={{ backgroundImage: `url(${item.imageUrls[0].startsWith("drive:") ? "" : item.imageUrls[0]})` }} /> : null}
                  <div className="split">
                    <span className="badge">{item.status}</span>
                    <span className="muted">{item.localTime}</span>
                  </div>
                  <span className="badge badge-neutral">{item.approvalStatus}</span>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
