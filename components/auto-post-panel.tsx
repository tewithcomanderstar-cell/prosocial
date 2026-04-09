"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type AutoPostConfig = {
  enabled: boolean;
  folderId: string;
  folderName: string;
  targetPageIds: string[];
  intervalHours: number;
  minRandomDelayMinutes: number;
  maxRandomDelayMinutes: number;
  maxPostsPerDay: number;
  maxPostsPerPagePerDay: number;
  captionStrategy: "manual" | "ai" | "hybrid";
  captions: string[];
  aiPrompt: string;
  language: "th" | "en";
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "pending" | "posted" | "failed" | "paused";
  lastError?: string | null;
  lastSelectedImageId?: string | null;
};

type Folder = { id: string; name: string };

type DriveImage = {
  id: string;
  name: string;
  thumbnailLink?: string;
  webViewLink?: string;
};

type FacebookPage = {
  pageId: string;
  name: string;
  category?: string;
};

type JobLog = {
  _id: string;
  targetPageId?: string;
  status: string;
  createdAt?: string;
  lastError?: string;
};

const defaults: AutoPostConfig = {
  enabled: false,
  folderId: "root",
  folderName: "My Drive",
  targetPageIds: [],
  intervalHours: 6,
  minRandomDelayMinutes: 5,
  maxRandomDelayMinutes: 30,
  maxPostsPerDay: 12,
  maxPostsPerPagePerDay: 4,
  captionStrategy: "hybrid",
  captions: [],
  aiPrompt: "",
  language: "th"
};

export function AutoPostPanel() {
  const [config, setConfig] = useState<AutoPostConfig>(defaults);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [images, setImages] = useState<DriveImage[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function bootstrap() {
      setLoading(true);
      setError("");
      try {
        const [configRes, pagesRes, foldersRes, logsRes] = await Promise.all([
          fetch("/api/auto-post"),
          fetch("/api/facebook/pages"),
          fetch("/api/google-drive/folders"),
          fetch("/api/auto-post/logs")
        ]);

        const [configJson, pagesJson, foldersJson, logsJson] = await Promise.all([
          configRes.json(),
          pagesRes.json(),
          foldersRes.json(),
          logsRes.json()
        ]);

        if (configJson.ok && configJson.data?.config) {
          setConfig({ ...defaults, ...configJson.data.config });
        }
        if (pagesJson.ok) {
          setPages(pagesJson.data?.pages ?? []);
        }
        if (foldersJson.ok) {
          setFolders(foldersJson.data?.folders ?? []);
        }
        if (logsJson.ok) {
          setLogs(logsJson.data?.jobs ?? []);
        }
      } catch (bootstrapError) {
        setError(bootstrapError instanceof Error ? bootstrapError.message : "Unable to load Auto Post settings");
      } finally {
        setLoading(false);
      }
    }

    bootstrap();
  }, []);

  useEffect(() => {
    async function loadImages() {
      if (!config.folderId) {
        setImages([]);
        return;
      }

      try {
        const response = await fetch(`/api/google-drive/images?folderId=${encodeURIComponent(config.folderId)}`);
        const result = await response.json();
        if (result.ok) {
          setImages(result.data?.images ?? []);
        }
      } catch {
        setImages([]);
      }
    }

    loadImages();
  }, [config.folderId]);

  const selectedPageNames = useMemo(() => {
    return pages.filter((page) => config.targetPageIds.includes(page.pageId)).map((page) => page.name);
  }, [config.targetPageIds, pages]);

  function togglePage(pageId: string) {
    setConfig((current) => ({
      ...current,
      targetPageIds: current.targetPageIds.includes(pageId)
        ? current.targetPageIds.filter((id) => id !== pageId)
        : [...current.targetPageIds, pageId]
    }));
  }

  function updateCaptions(value: string) {
    setConfig((current) => ({
      ...current,
      captions: value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.message || "Unable to save Auto Post settings");
      }

      setConfig({ ...defaults, ...result.data.config });
      setMessage(config.enabled ? "Auto Post settings saved" : "Auto Post paused");

      const logsResponse = await fetch("/api/auto-post/logs");
      const logsResult = await logsResponse.json();
      if (logsResult.ok) {
        setLogs(logsResult.data?.jobs ?? []);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to save Auto Post settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="muted">Loading Auto Post settings...</p>;
  }

  return (
    <div className="stack auto-post-shell">
      {message ? <div className="composer-message">{message}</div> : null}
      {error ? <div className="composer-message composer-message-error">{error}</div> : null}

      <form className="card auto-post-card" onSubmit={handleSubmit}>
        <div className="split auto-post-head">
          <div className="stack">
            <div className="kicker">AUTO POST</div>
            <h3>Auto Post from Google Drive</h3>
            <p className="muted">Pick a Drive folder, choose Facebook pages, set your interval, and let the scheduler queue posts automatically.</p>
          </div>
          <label className="auto-post-toggle">
            <span>{config.enabled ? "Enabled" : "Paused"}</span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.checked }))}
            />
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid">
          <label className="label">
            Google Drive folder
            <select
              className="select"
              value={config.folderId}
              onChange={(event) => {
                const folder = folders.find((item) => item.id === event.target.value);
                setConfig((current) => ({
                  ...current,
                  folderId: event.target.value,
                  folderName: folder?.name ?? current.folderName
                }));
              }}
            >
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
            </select>
          </label>

          <label className="label">
            Interval (hours)
            <input
              className="input"
              type="number"
              min={1}
              max={24}
              value={config.intervalHours}
              onChange={(event) => setConfig((current) => ({ ...current, intervalHours: Number(event.target.value) || 1 }))}
            />
          </label>

          <label className="label">
            Min random delay (minutes)
            <input
              className="input"
              type="number"
              min={0}
              max={720}
              value={config.minRandomDelayMinutes}
              onChange={(event) => setConfig((current) => ({ ...current, minRandomDelayMinutes: Number(event.target.value) || 0 }))}
            />
          </label>

          <label className="label">
            Max random delay (minutes)
            <input
              className="input"
              type="number"
              min={0}
              max={1440}
              value={config.maxRandomDelayMinutes}
              onChange={(event) => setConfig((current) => ({ ...current, maxRandomDelayMinutes: Number(event.target.value) || 0 }))}
            />
          </label>

          <label className="label">
            Max posts per day
            <input
              className="input"
              type="number"
              min={1}
              max={200}
              value={config.maxPostsPerDay}
              onChange={(event) => setConfig((current) => ({ ...current, maxPostsPerDay: Number(event.target.value) || 1 }))}
            />
          </label>

          <label className="label">
            Max posts per page / day
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={config.maxPostsPerPagePerDay}
              onChange={(event) => setConfig((current) => ({ ...current, maxPostsPerPagePerDay: Number(event.target.value) || 1 }))}
            />
          </label>

          <label className="label">
            Caption mode
            <select
              className="select"
              value={config.captionStrategy}
              onChange={(event) => setConfig((current) => ({ ...current, captionStrategy: event.target.value as AutoPostConfig["captionStrategy"] }))}
            >
              <option value="manual">Manual captions only</option>
              <option value="hybrid">AI with manual fallback</option>
              <option value="ai">AI only</option>
            </select>
          </label>

          <label className="label">
            Language
            <select
              className="select"
              value={config.language}
              onChange={(event) => setConfig((current) => ({ ...current, language: event.target.value as AutoPostConfig["language"] }))}
            >
              <option value="th">Thai</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>

        <label className="label">
          AI prompt (optional)
          <input
            className="input"
            value={config.aiPrompt}
            onChange={(event) => setConfig((current) => ({ ...current, aiPrompt: event.target.value }))}
            placeholder="Example: Thai restaurant promo, friendly tone, close the sale"
          />
        </label>

        <label className="label">
          Manual captions (one line per caption)
          <textarea
            className="textarea"
            value={config.captions.join("\n")}
            onChange={(event) => updateCaptions(event.target.value)}
            placeholder="Fallback captions to rotate when AI is unavailable"
          />
        </label>

        <div className="stack">
          <div className="split">
            <strong>Target Facebook pages</strong>
            <span className="muted">Randomize between selected pages {selectedPageNames.length ? `(${selectedPageNames.join(", ")})` : ""}</span>
          </div>
          <div className="chip-grid">
            {pages.map((page) => (
              <button
                key={page.pageId}
                type="button"
                className={`choice-chip ${config.targetPageIds.includes(page.pageId) ? "active" : ""}`}
                onClick={() => togglePage(page.pageId)}
              >
                {page.name}
              </button>
            ))}
          </div>
        </div>

        <div className="minimal-action-stack">
          <button className="button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save Auto Post settings"}</button>
        </div>
      </form>

      <div className="grid cols-2 auto-post-grid">
        <section className="card auto-post-card">
          <div className="split">
            <div>
              <h3>Folder image preview</h3>
              <p className="muted">These images become the random source pool for Auto Post.</p>
            </div>
            <span className="badge badge-neutral">{images.length} images</span>
          </div>
          <div className="auto-post-image-grid">
            {images.length ? images.slice(0, 8).map((image) => (
              <article key={image.id} className="minimal-image-card">
                {image.thumbnailLink ? <img className="minimal-image-preview" src={image.thumbnailLink} alt={image.name} /> : <div className="minimal-image-preview auto-post-preview-fallback">IMG</div>}
                <div className="minimal-image-meta">
                  <span>{image.name}</span>
                </div>
              </article>
            )) : <div className="composer-media-empty">No images found in this folder.</div>}
          </div>
        </section>

        <section className="card auto-post-card">
          <div className="split">
            <div>
              <h3>Recent Auto Post status</h3>
              <p className="muted">Track queued, posted, failed, and retrying jobs.</p>
            </div>
            <span className={`badge ${config.lastStatus === "failed" ? "badge-warn" : "badge-neutral"}`}>{config.lastStatus ?? "paused"}</span>
          </div>

          <div className="stack auto-post-status-box">
            <div className="list-item"><span>Next run</span><strong>{config.nextRunAt ? new Date(config.nextRunAt).toLocaleString() : "-"}</strong></div>
            <div className="list-item"><span>Last run</span><strong>{config.lastRunAt ? new Date(config.lastRunAt).toLocaleString() : "-"}</strong></div>
            <div className="list-item"><span>Last error</span><strong>{config.lastError || "None"}</strong></div>
          </div>

          <div className="stack">
            {logs.length ? logs.map((job) => (
              <article key={job._id} className="auto-post-log-item">
                <div className="split">
                  <strong>{job.status}</strong>
                  <span className="muted">{job.createdAt ? new Date(job.createdAt).toLocaleString() : "-"}</span>
                </div>
                <div className="muted">Page: {job.targetPageId || "-"}</div>
                {job.lastError ? <div className="auto-post-log-error">{job.lastError}</div> : null}
              </article>
            )) : <div className="composer-media-empty">No Auto Post logs yet.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
