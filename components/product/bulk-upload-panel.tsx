"use client";

import { useState } from "react";

export function BulkUploadPanel() {
  const [csv, setCsv] = useState("title,content,hashtags,targetPageIds,runAt,frequency\nCampaign A,Hello world,#sale,page-1|page-2,2026-04-10T10:00:00.000Z,once");
  const [message, setMessage] = useState("");

  async function handleUpload() {
    const response = await fetch("/api/bulk/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, timezone: "Asia/Bangkok" })
    });
    const result = await response.json();
    setMessage(result.message || (result.ok ? `Created ${result.data.createdCount} posts` : "Bulk upload failed"));
  }

  return (
    <div className="stack">
      <label className="label">
        CSV
        <textarea className="textarea" value={csv} onChange={(e) => setCsv(e.target.value)} />
      </label>
      <button className="button" type="button" onClick={handleUpload}>Bulk upload</button>
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}
