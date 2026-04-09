"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type AutoPostStatus = "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";

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
  autoPostStatus?: AutoPostStatus;
  jobStatus?: "pending" | "processing" | "posted" | "failed";
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string | null;
  retryCount?: number;
};

type Folder = { id: string; name: string };

type DriveImage = {
  id: string;
  name: string;
  thumbnailLink?: string;
};

type FacebookPage = {
  pageId: string;
  name: string;
};

type StatusLog = {
  _id: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

type StatusResponse = {
  config: AutoPostConfig;
  logs: StatusLog[];
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
  language: "th",
  autoPostStatus: "paused",
  jobStatus: "pending",
  retryCount: 0
};

function formatDateTime(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function statusLabel(status?: AutoPostStatus) {
  switch (status) {
    case "running":
      return "Running";
    case "posting":
      return "Posting";
    case "success":
      return "Success";
    case "failed":
      return "Failed";
    case "retrying":
      return "Retrying";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "paused":
    default:
      return "Paused";
  }
}

function jobStatusLabel(status?: AutoPostConfig["jobStatus"]) {
  switch (status) {
    case "processing":
      return "Processing";
    case "posted":
      return "Posted";
    case "failed":
      return "Failed";
    case "pending":
    default:
      return "Pending";
  }
}

function statusTone(status?: AutoPostStatus) {
  switch (status) {
    case "running":
    case "posting":
      return "badge-info";
    case "success":
      return "badge-success";
    case "failed":
      return "badge-warn";
    case "retrying":
    case "waiting":
    case "idle":
      return "badge-neutral";
    case "paused":
    default:
      return "badge-neutral";
  }
}

export function AutoPostPanel() {
  const [config, setConfig] = useState<AutoPostConfig>(defaults);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [images, setImages] = useState<DriveImage[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [logs, setLogs] = useState<StatusLog[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [stopping, setStopping] = useState(false);

  const loadStatus = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);

    try {
      const [statusRes, pagesRes, foldersRes] = await Promise.all([
        fetch("/api/auto-post/status", { cache: "no-store" }),
        fetch("/api/facebook/pages", { cache: "no-store" }),
        fetch("/api/google-drive/folders", { cache: "no-store" })
      ]);

      const [statusJson, pagesJson, foldersJson] = await Promise.all([
        statusRes.json(),
        pagesRes.json(),
        foldersRes.json()
      ]);

      if (statusJson.ok) {
        const statusData = statusJson.data as StatusResponse;
        setConfig((current) => ({ ...current, ...defaults, ...statusData.config }));
        setLogs(statusData.logs ?? []);
      }
      if (pagesJson.ok) {
        setPages(pagesJson.data?.pages ?? []);
      }
      if (foldersJson.ok) {
        setFolders(foldersJson.data?.folders ?? []);
      }
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Unable to load Auto Post status");
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus(true);
  }, [loadStatus]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      loadStatus(false);
    }, 10000);

    return () => window.clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    async function loadImages() {
      if (!config.folderId) {
        setImages([]);
        return;
      }

      try {
        const response = await fetch(`/api/google-drive/images?folderId=${encodeURIComponent(config.folderId)}`, {
          cache: "no-store"
        });
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

  const selectedPageNames = useMemo(() => pages.filter((page) => config.targetPageIds.includes(page.pageId)).map((page) => page.name), [config.targetPageIds, pages]);
  const startDisabled = starting || saving || ["running", "posting", "retrying"].includes(config.autoPostStatus ?? "");

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

  async function saveConfig(enabledOverride?: boolean) {
    const response = await fetch("/api/auto-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, enabled: enabledOverride ?? config.enabled })
    });
    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.message || "Unable to save Auto Post settings");
    }
    setConfig({ ...defaults, ...result.data.config });
    return result;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const result = await saveConfig();
      setMessage(result.message || (config.enabled ? "Auto Post settings saved" : "Auto Post paused"));
      await loadStatus(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to save Auto Post settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleStartNow() {
    setStarting(true);
    setMessage("");
    setError("");

    try {
      await saveConfig(true);
      const response = await fetch("/api/auto-post/start", { method: "POST" });
      const result = await response.json();
      if (!result.ok) throw new Error(result.message || "Unable to start Auto Post");
      setMessage("Start signal sent to n8n");
      await loadStatus(false);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Unable to start Auto Post");
    } finally {
      setStarting(false);
    }
  }

  async function handlePause() {
    setPausing(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/auto-post/pause", { method: "POST" });
      const result = await response.json();
      if (!result.ok) throw new Error(result.message || "Unable to pause Auto Post");
      setMessage("Auto Post paused");
      await loadStatus(false);
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : "Unable to pause Auto Post");
    } finally {
      setPausing(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/auto-post/stop", { method: "POST" });
      const result = await response.json();
      if (!result.ok) throw new Error(result.message || "Unable to stop Auto Post");
      setMessage("Auto Post stopped");
      await loadStatus(false);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Unable to stop Auto Post");
    } finally {
      setStopping(false);
    }
  }

  if (loading) {
    return <p className="muted">Loading control panel...</p>;
  }

  return (
    <div className="stack auto-post-shell">
      {message ? <div className="composer-message">{message}</div> : null}
      {error ? <div className="composer-message composer-message-error">{error}</div> : null}

      <form className="card auto-post-card" onSubmit={handleSubmit}>
        <div className="split auto-post-head">
          <div className="stack">
            <div className="kicker">AUTO POST</div>
            <h3>Control Panel</h3>
          </div>
          <label className="auto-post-toggle">
            <span>{config.enabled ? "Enabled" : "Disabled"}</span>
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
            <select className="select" value={config.folderId} onChange={(event) => {
              const folder = folders.find((item) => item.id === event.target.value);
              setConfig((current) => ({ ...current, folderId: event.target.value, folderName: folder?.name ?? current.folderName }));
            }}>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>

          <label className="label">
            Interval (hours)
            <input className="input" type="number" min={1} max={24} value={config.intervalHours} onChange={(event) => setConfig((current) => ({ ...current, intervalHours: Number(event.target.value) || 1 }))} />
          </label>

          <label className="label">
            Min random delay (minutes)
            <input className="input" type="number" min={0} max={720} value={config.minRandomDelayMinutes} onChange={(event) => setConfig((current) => ({ ...current, minRandomDelayMinutes: Number(event.target.value) || 0 }))} />
          </label>

          <label className="label">
            Max random delay (minutes)
            <input className="input" type="number" min={0} max={1440} value={config.maxRandomDelayMinutes} onChange={(event) => setConfig((current) => ({ ...current, maxRandomDelayMinutes: Number(event.target.value) || 0 }))} />
          </label>

          <label className="label">
            Caption mode
            <select className="select" value={config.captionStrategy} onChange={(event) => setConfig((current) => ({ ...current, captionStrategy: event.target.value as AutoPostConfig["captionStrategy"] }))}>
              <option value="manual">Manual</option>
              <option value="hybrid">Hybrid</option>
              <option value="ai">AI</option>
            </select>
          </label>

          <label className="label">
            Language
            <select className="select" value={config.language} onChange={(event) => setConfig((current) => ({ ...current, language: event.target.value as AutoPostConfig["language"] }))}>
              <option value="th">Thai</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>

        <label className="label">
          AI prompt
          <input className="input" value={config.aiPrompt} onChange={(event) => setConfig((current) => ({ ...current, aiPrompt: event.target.value }))} placeholder="Optional prompt for n8n or AI caption generation" />
        </label>

        <label className="label">
          Captions
          <textarea className="textarea" value={config.captions.join("\n")} onChange={(event) => updateCaptions(event.target.value)} placeholder="One caption per line" />
        </label>

        <div className="stack">
          <div className="split">
            <strong>Facebook pages</strong>
            <span className="muted">{selectedPageNames.length ? selectedPageNames.join(", ") : "No pages selected"}</span>
          </div>
          <div className="chip-grid">
            {pages.map((page) => (
              <button key={page.pageId} type="button" className={`choice-chip ${config.targetPageIds.includes(page.pageId) ? "active" : ""}`} onClick={() => togglePage(page.pageId)}>
                {page.name}
              </button>
            ))}
          </div>
        </div>

        <div className="minimal-action-stack auto-post-actions auto-post-actions-3">
          <button className="button button-secondary" type="button" onClick={handleStartNow} disabled={startDisabled}>{starting ? "Starting..." : "Start Now"}</button>
          <button className="button button-secondary" type="button" onClick={handlePause} disabled={pausing || stopping}>{pausing ? "Pausing..." : "Pause"}</button>
          <button className="button button-secondary" type="button" onClick={handleStop} disabled={stopping || pausing}>{stopping ? "Stopping..." : "Stop"}</button>
          <button className="button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save Settings"}</button>
        </div>
      </form>

      <div className="grid cols-2 auto-post-grid">
        <section className="card auto-post-card">
          <div className="split">
            <h3>Folder Preview</h3>
            <span className="badge badge-neutral">{images.length} images</span>
          </div>
          <div className="auto-post-image-grid">
            {images.length ? images.slice(0, 8).map((image) => (
              <article key={image.id} className="minimal-image-card">
                {image.thumbnailLink ? <img className="minimal-image-preview" src={image.thumbnailLink} alt={image.name} /> : <div className="minimal-image-preview auto-post-preview-fallback">IMG</div>}
                <div className="minimal-image-meta"><span>{image.name}</span></div>
              </article>
            )) : <div className="composer-media-empty">No images found.</div>}
          </div>
        </section>

        <section className="card auto-post-card">
          <div className="split">
            <h3>Status</h3>
            <span className={`badge ${statusTone(config.autoPostStatus)}`}>{statusLabel(config.autoPostStatus)}</span>
          </div>

          <div className="grid cols-2 auto-post-metrics">
            <div className="auto-post-metric-card"><span className="muted">Last run</span><strong>{formatDateTime(config.lastRunAt)}</strong></div>
            <div className="auto-post-metric-card"><span className="muted">Next run</span><strong>{formatDateTime(config.nextRunAt)}</strong></div>
            <div className="auto-post-metric-card"><span className="muted">Current job</span><strong>{jobStatusLabel(config.jobStatus)}</strong></div>
            <div className="auto-post-metric-card"><span className="muted">Retry count</span><strong>{config.retryCount ?? 0}</strong></div>
          </div>

          <div className="stack auto-post-status-box">
            <div className="list-item"><span>Folder</span><strong>{config.folderName || "My Drive"}</strong></div>
            <div className="list-item"><span>Pages</span><strong>{selectedPageNames.length || 0}</strong></div>
            <div className="list-item"><span>Worker</span><strong>n8n webhook</strong></div>
            <div className="list-item"><span>Last error</span><strong>{config.lastError || "None"}</strong></div>
          </div>

          <div className="stack">
            <div className="split">
              <h3>Latest log</h3>
              <span className="badge badge-neutral">{logs.length} entries</span>
            </div>
            <div className="auto-post-log-list">
              {logs.length ? logs.map((log) => (
                <article key={log._id} className="auto-post-log-item">
                  <div className="split">
                    <strong>{log.message}</strong>
                    <span className={`badge ${log.level === "error" ? "badge-warn" : log.level === "success" ? "badge-success" : "badge-neutral"}`}>{log.level}</span>
                  </div>
                  <div className="muted">{formatDateTime(log.createdAt)}</div>
                  {log.metadata?.pageId ? <div className="muted">Page: {String(log.metadata.pageId)}</div> : null}
                  {log.metadata?.autoPostStatus ? <div className="muted">Status: {String(log.metadata.autoPostStatus)}</div> : null}
                </article>
              )) : <div className="composer-media-empty">No logs yet.</div>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
