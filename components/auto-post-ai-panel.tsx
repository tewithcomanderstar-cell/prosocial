"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type AutoPostStatus = "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
type CaptionStrategy = "manual" | "ai" | "hybrid";
type AutomationMode = "standard" | "multi-image-ai";
type MultiImageCountMode = "4" | "5" | "6-10";
type CaptionLengthMode = "balanced" | "short";

type AutoPostConfig = {
  enabled: boolean;
  folderId: string;
  folderName: string;
  targetPageIds: string[];
  intervalMinutes: number;
  captionStrategy: CaptionStrategy;
  automationMode: AutomationMode;
  multiImageCountMode: MultiImageCountMode;
  captionLengthMode: CaptionLengthMode;
  captions: string[];
  hashtags: string[];
  aiPrompt: string;
  postingWindowStart: string;
  postingWindowEnd: string;
  autoCommentEnabled: boolean;
  autoCommentIntervalMinutes: 15 | 30 | 60;
  language: "th" | "en";
  autoPostStatus?: AutoPostStatus;
  jobStatus?: "pending" | "processing" | "posted" | "failed";
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string | null;
  retryCount?: number;
};

type Folder = { id: string; name: string };
type FacebookPage = { pageId: string; name: string };

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

const MAX_TARGET_PAGES = 100;
const INTERVAL_OPTIONS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" }
] as const;

const DEFAULT_MULTI_IMAGE_AI_PROMPT = `เขียนแคปชั่น Facebook ภาษาไทยสำหรับโพสต์หลายภาพ ให้เป็นสไตล์คอนเทนต์น่ารัก ละมุน ชวนหยุดดู ชวนเซฟ และชวนคอมเมนต์ เปิดโพสต์ด้วย hook แบบชวนหยุดอ่าน เช่น ยังไม่มีไอเดียใช่มั้ย หรือ หยุดตรงนี้ก่อนเลยน้า จากนั้นสรุปว่าโพสต์นี้รวมไอเดียอะไร แล้วไล่อธิบายทีละรูปเป็น แบบ 1 / แบบ 2 / แบบ 3 ... ให้แต่ละรูปมีฟีลต่างกัน ปิดท้ายด้วย CTA ให้คอมเมนต์ เซฟ และแชร์ โดยต้องอิงจากรายละเอียดในภาพจริง ห้ามเขียนกว้างหรือมั่ว`;

const defaults: AutoPostConfig = {
  enabled: false,
  folderId: "root",
  folderName: "My Drive",
  targetPageIds: [],
  intervalMinutes: 60,
  captionStrategy: "hybrid",
  automationMode: "multi-image-ai",
  multiImageCountMode: "4",
  captionLengthMode: "balanced",
  captions: [],
  hashtags: [],
  aiPrompt: DEFAULT_MULTI_IMAGE_AI_PROMPT,
  postingWindowStart: "06:00",
  postingWindowEnd: "00:00",
  autoCommentEnabled: false,
  autoCommentIntervalMinutes: 15,
  language: "th",
  autoPostStatus: "paused",
  jobStatus: "pending",
  retryCount: 0
};

function formatDateTime(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function sanitizeText(value?: string | null) {
  if (!value) return "";
  const raw = value.trim();
  if (!raw) return "";

  const withoutTags = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const normalized = withoutTags || raw;
  return normalized.length > 240 ? normalized.slice(0, 237) + "..." : normalized;
}

function sanitizeAutomationError(value?: string | null) {
  if (!value) return "";

  const normalized = value.toLowerCase();
  if (
    normalized.includes("n8n") ||
    normalized.includes("requested webhook") ||
    normalized.includes("workflow must be active") ||
    normalized.includes("webhook")
  ) {
    return "Legacy automation state detected. Please refresh and trigger Start Now again.";
  }

  return sanitizeText(value);
}

async function readApiResult(response: Response) {
  const rawText = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText) as { ok?: boolean; message?: string; data?: any };
    } catch {
      return {
        ok: false,
        message: sanitizeAutomationError(rawText || "The server returned invalid JSON.")
      };
    }
  }

  return {
    ok: false,
    message: sanitizeAutomationError(rawText || "The server returned an unexpected response.")
  };
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
      return "badge-neutral";
    case "idle":
    case "paused":
    default:
      return "badge-neutral";
  }
}

export function AutoPostAiPanel() {
  const forcedAutomationMode: AutomationMode = "multi-image-ai";
  const hideAutomationModeSelector = true;
  const [config, setConfig] = useState<AutoPostConfig>(defaults);
  const [folders, setFolders] = useState<Folder[]>([]);
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
        fetch("/api/auto-post-ai/status", { cache: "no-store" }),
        fetch("/api/facebook/pages", { cache: "no-store" }),
        fetch("/api/google-drive/folders", { cache: "no-store" })
      ]);

      const [statusJson, pagesJson, foldersJson] = await Promise.all([
        readApiResult(statusRes),
        readApiResult(pagesRes),
        readApiResult(foldersRes)
      ]);

      if (statusJson.ok) {
        const statusData = statusJson.data as StatusResponse;
        setConfig((current) => ({
          ...current,
          ...defaults,
          ...statusData.config,
          ...(forcedAutomationMode ? { automationMode: forcedAutomationMode } : {}),
          aiPrompt: statusData.config.aiPrompt?.trim() ? statusData.config.aiPrompt : DEFAULT_MULTI_IMAGE_AI_PROMPT
        }));
        setLogs((statusData.logs ?? []).slice(0, 10).map((log) => ({ ...log, message: sanitizeText(log.message) })));
      }

      if (pagesJson.ok) setPages(pagesJson.data?.pages ?? []);
      if (foldersJson.ok) setFolders(foldersJson.data?.folders ?? []);
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
    const interval = window.setInterval(() => loadStatus(false), 10000);
    return () => window.clearInterval(interval);
  }, [loadStatus]);

  const selectedPageNames = useMemo(
    () => pages.filter((page) => config.targetPageIds.includes(page.pageId)).map((page) => page.name),
    [config.targetPageIds, pages]
  );

  const startDisabled = starting || saving || ["running", "posting", "retrying"].includes(config.autoPostStatus ?? "");

  function togglePage(pageId: string) {
    setConfig((current) => {
      if (current.targetPageIds.includes(pageId)) {
        return {
          ...current,
          targetPageIds: current.targetPageIds.filter((id) => id !== pageId)
        };
      }

      if (current.targetPageIds.length >= MAX_TARGET_PAGES) {
        setError(`You can select up to ${MAX_TARGET_PAGES} pages.`);
        return current;
      }

      return {
        ...current,
        targetPageIds: [...current.targetPageIds, pageId]
      };
    });
  }

  function updateCaptions(value: string) {
    setConfig((current) => ({
      ...current,
      captions: value.split("\n").map((item) => item.trim()).filter(Boolean)
    }));
  }

  function updateHashtags(value: string) {
    setConfig((current) => ({
      ...current,
      hashtags: value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean)
    }));
  }

  async function saveConfig(enabledOverride?: boolean) {
    const response = await fetch("/api/auto-post-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...config,
        automationMode: "multi-image-ai",
        enabled: enabledOverride ?? config.enabled
      })
    });
    const result = await readApiResult(response);
    if (!result.ok) throw new Error(result.message || "Unable to save Auto Post settings");
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
      setMessage(result.message || "Settings saved");
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
      const response = await fetch("/api/auto-post-ai/start", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to start Auto Post");
      setMessage(result.message || (result.data?.waiting ? "Automation is waiting for more eligible images" : "Automation started"));
      await loadStatus(false);
    } catch (startError) {
      setError(sanitizeAutomationError(startError instanceof Error ? startError.message : "Unable to start Auto Post"));
    } finally {
      setStarting(false);
    }
  }

  async function handlePause() {
    setPausing(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post-ai/pause", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to pause Auto Post");
      setMessage("Auto Post paused");
      await loadStatus(false);
    } catch (pauseError) {
      setError(sanitizeAutomationError(pauseError instanceof Error ? pauseError.message : "Unable to pause Auto Post"));
    } finally {
      setPausing(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post-ai/stop", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to stop Auto Post");
      setMessage("Auto Post stopped");
      await loadStatus(false);
    } catch (stopError) {
      setError(sanitizeAutomationError(stopError instanceof Error ? stopError.message : "Unable to stop Auto Post"));
    } finally {
      setStopping(false);
    }
  }

  if (loading) {
    return <p className="muted">Loading control panel...</p>;
  }

  return (
    <div className="auto-post-minimal-layout">
      <form className="card auto-post-card auto-post-config-card" onSubmit={handleSubmit}>
        <div className="split auto-post-head auto-post-head-minimal">
          <div className="stack compact-stack">
            <div className="kicker">Config</div>
            <h3>Auto Post Setup</h3>
          </div>
          <label className="auto-post-toggle">
            <span>{config.enabled ? "On" : "Off"}</span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.checked }))}
            />
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Google Drive Folder
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
            Every
            <select
              className="select"
              value={config.intervalMinutes}
              onChange={(event) => setConfig((current) => ({ ...current, intervalMinutes: Number(event.target.value) || 60 }))}
            >
              {INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Post from
            <input
              className="input"
              type="time"
              value={config.postingWindowStart}
              onChange={(event) => setConfig((current) => ({ ...current, postingWindowStart: event.target.value }))}
            />
          </label>

          <label className="label">
            Until
            <input
              className="input"
              type="time"
              value={config.postingWindowEnd}
              onChange={(event) => setConfig((current) => ({ ...current, postingWindowEnd: event.target.value }))}
            />
          </label>
        </div>

        <div className="stack compact-stack">
          <div className="split compact-row">
            <strong>Facebook Pages</strong>
            <span className="muted">{selectedPageNames.length} / {MAX_TARGET_PAGES} selected</span>
          </div>
          <div className="chip-grid">
            {pages.map((page) => {
              const active = config.targetPageIds.includes(page.pageId);
              const disabled = !active && config.targetPageIds.length >= MAX_TARGET_PAGES;
              return (
                <button
                  key={page.pageId}
                  type="button"
                  className={`choice-chip ${active ? "active" : ""}`}
                  onClick={() => togglePage(page.pageId)}
                  disabled={disabled}
                >
                  {page.name}
                </button>
              );
            })}
          </div>
        </div>

        {<div className="muted">โหมดนี้แยกการทำงานจากระบบออโต้ปกติ และจะใช้ AI สร้างโพสต์หลายภาพโดยเฉพาะ</div>}

        {config.automationMode === "multi-image-ai" ? (
          <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
            <label className="label">
              รูปต่อโพสต์
              <select
                className="select"
                value={config.multiImageCountMode}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, multiImageCountMode: event.target.value as MultiImageCountMode }))
                }
              >
                <option value="4">โพส 4 ภาพ</option>
                <option value="5">โพส 5 ภาพ</option>
                <option value="6-10">โพส 6-10 ภาพ</option>
              </select>
            </label>

            <label className="label">
              ความยาวแคปชั่น
              <select
                className="select"
                value={config.captionLengthMode}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, captionLengthMode: event.target.value as CaptionLengthMode }))
                }
              >
                <option value="balanced">ปกติอ่านสบาย</option>
                <option value="short">โหมดสั้นพิเศษ</option>
              </select>
            </label>
          </div>
        ) : null}

        {config.automationMode === "multi-image-ai" ? (
          <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
            <label className="auto-post-toggle">
              <span>{config.autoCommentEnabled ? "เปิด Auto Comment" : "ปิด Auto Comment"}</span>
              <input
                type="checkbox"
                checked={config.autoCommentEnabled}
                onChange={(event) => setConfig((current) => ({ ...current, autoCommentEnabled: event.target.checked }))}
              />
            </label>

            <label className="label">
              รอบดึงคอมเมนต์
              <select
                className="select"
                value={config.autoCommentIntervalMinutes}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    autoCommentIntervalMinutes: Number(event.target.value) as 15 | 30 | 60
                  }))
                }
                disabled={!config.autoCommentEnabled}
              >
                <option value="15">ทุก 15 นาที</option>
                <option value="30">ทุก 30 นาที</option>
                <option value="60">ทุก 1 ชั่วโมง</option>
              </select>
            </label>
          </div>
        ) : null}

        <label className="label">
          Caption Mode
          <select
            className="select"
            value={config.captionStrategy}
            onChange={(event) => setConfig((current) => ({ ...current, captionStrategy: event.target.value as CaptionStrategy }))}
            disabled={config.automationMode === "multi-image-ai"}
          >
            <option value="manual">Manual</option>
            <option value="hybrid">Manual + AI</option>
            <option value="ai">AI only (copy text from image)</option>
          </select>
        </label>

        <label className="label">
          Captions
          <textarea
            className="textarea auto-post-captions"
            value={config.captions.join("\n")}
            onChange={(event) => updateCaptions(event.target.value)}
            placeholder="One caption per line"
          />
        </label>

        <label className="label">
          Hashtags
          <textarea
            className="textarea auto-post-captions"
            value={config.hashtags.join(" ")}
            onChange={(event) => updateHashtags(event.target.value)}
            placeholder="#บ้านช้างบ้าน #แคปชั่นบ้าน #fypp"
          />
        </label>

        <label className="label">
          AI Prompt
          <input
            className="input"
            value={config.aiPrompt}
            onChange={(event) => setConfig((current) => ({ ...current, aiPrompt: event.target.value }))}
            placeholder={config.captionStrategy === "hybrid" ? "Tell AI exactly how to rewrite the image text/caption" : "Optional"}
          />
        </label>

        <div className="muted">Unique image assignment per page is handled by the in-app automation engine for each run.</div>
        {config.automationMode === "multi-image-ai" ? (
          <div className="muted">
            โหมดหลายภาพ AI จะสุ่มภาพที่มีธีมใกล้กันจากโฟลเดอร์, จับแกนหลักของภาพ และคิดแคปชั่นใหม่ให้เองโดยไม่ใช้ Caption Mode ปกติ
          </div>
        ) : null}
        {config.automationMode === "multi-image-ai" ? (
          <div className="muted">
            {config.captionLengthMode === "short"
              ? "โหมดสั้นพิเศษจะบีบให้แคปชั่นเหลือประมาณ 5-7 บรรทัด และตัดคำอธิบายให้กระชับที่สุด"
              : "โหมดปกติอ่านสบายจะคงโครงสร้างเดิม แต่จัดให้อ่านง่ายขึ้นและไม่แน่นเกินไป"}
          </div>
        ) : null}
        {config.automationMode === "multi-image-ai" && config.autoCommentEnabled ? (
          <div className="muted">
            Auto Comment ของโหมดนี้จะตามดูคอมเมนต์ในโพสต์ที่ระบบโพสต์ให้เอง และถ้าลูกเพจพิมพ์เลข 1-4 ระบบจะทายนิสัยตามแบบเล็บของโพสต์นั้นโดยตรง
          </div>
        ) : null}
        {config.automationMode === "multi-image-ai" ? (
          <div className="muted">ระบบจะพยายามใช้ภาพให้หมดก่อน, ไม่ซ้ำในวันเดียวกัน และกันภาพเดิมซ้ำภายใน 24 ชั่วโมงเท่าที่จำนวนภาพเอื้ออำนวย</div>
        ) : null}
        {config.captionStrategy === "ai" ? (
          <div className="muted">AI only extracts visible text from each image as-is and does not rewrite the caption.</div>
        ) : null}
        {config.captionStrategy === "hybrid" ? (
          <div className="muted">Manual + AI uses your AI Prompt like a real ChatGPT instruction and rewrites from the manual caption plus text detected in the image.</div>
        ) : null}
        <div className="muted">If you add hashtags here, the system appends them to every auto-post caption. Leave it blank to keep captions unchanged.</div>

        <button className="button" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </form>

      <section className="card auto-post-card auto-post-status-card">
        <div className="split auto-post-head auto-post-head-minimal">
          <div className="stack compact-stack">
            <div className="kicker">Status</div>
            <h3>Control & Monitor</h3>
          </div>
          <span className={`badge ${statusTone(config.autoPostStatus)}`}>{statusLabel(config.autoPostStatus)}</span>
        </div>

        {message ? <div className="composer-message">{message}</div> : null}
        {error ? <div className="composer-message composer-message-error">{error}</div> : null}

        <div className="auto-post-control-row">
          <button className="button button-secondary" type="button" onClick={handleStartNow} disabled={startDisabled}>
            {starting ? "Starting..." : "Start Now"}
          </button>
          <button className="button button-secondary" type="button" onClick={handlePause} disabled={pausing || stopping}>
            {pausing ? "Pausing..." : "Pause"}
          </button>
          <button className="button button-secondary" type="button" onClick={handleStop} disabled={stopping || pausing}>
            {stopping ? "Stopping..." : "Stop"}
          </button>
        </div>

        <div className="grid cols-2 auto-post-metrics auto-post-metrics-minimal">
          <div className="auto-post-metric-card"><span className="muted">Last run</span><strong>{formatDateTime(config.lastRunAt)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Next run</span><strong>{formatDateTime(config.nextRunAt)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Current job</span><strong>{jobStatusLabel(config.jobStatus)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Last error</span><strong>{sanitizeText(config.lastError) || "None"}</strong></div>
        </div>

        <div className="stack compact-stack">
          <div className="split compact-row">
            <strong>Latest activity</strong>
            <span className="badge badge-neutral">{logs.length}</span>
          </div>
          <div className="auto-post-log-list auto-post-log-list-minimal">
            {logs.length ? logs.map((log) => (
              <article key={log._id} className="auto-post-log-item">
                <div className="split compact-row">
                  <strong>{log.message}</strong>
                  <span className={`badge ${log.level === "error" ? "badge-warn" : log.level === "success" ? "badge-success" : "badge-neutral"}`}>
                    {log.level}
                  </span>
                </div>
                <div className="muted">{formatDateTime(log.createdAt)}</div>
                <div className="muted auto-post-log-meta">
                  {log.metadata?.pageId ? `Page ${String(log.metadata.pageId)}` : "System event"}
                  {log.metadata?.autoPostStatus ? ` • ${String(log.metadata.autoPostStatus)}` : ""}
                </div>
              </article>
            )) : <div className="composer-media-empty">No logs yet.</div>}
          </div>
        </div>
      </section>
    </div>
  );
}




