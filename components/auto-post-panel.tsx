"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type AutoPostStatus = "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
type CaptionStrategy = "manual" | "ai" | "hybrid";

type AutoPostConfig = {
  enabled: boolean;
  contentSource: "shopee-affiliate" | "google-drive";
  folderId: string;
  folderName: string;
  shopeeSourceTag: "trending" | "best_selling" | "top_search" | "best_roi" | "manual";
  shopeeKeyword: string;
  shopeeCategory: string;
  shopeeCaptionStyle: "soft_sell" | "urgency" | "problem_solution" | "review_style" | "deal_alert" | "lifestyle";
  shopeeTrackingId: string;
  shopeeBlockedCategories: string[];
  shopeeCategoryPriority: string[];
  targetPageIds: string[];
  intervalMinutes: number;
  captionStrategy: CaptionStrategy;
  captions: string[];
  hashtags: string[];
  aiPrompt: string;
  postingWindowStart: string;
  postingWindowEnd: string;
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
type PanelState = "loading" | "setup_required" | "facebook_required" | "ready" | "error";

type ControlPanelStatus = {
  state?: Exclude<PanelState, "loading" | "error">;
  shopeeApiStatus?: string;
  affiliateConfigStatus?: string;
  facebookPageStatus?: string;
  autoPostEngineStatus?: string;
  lastProductFetchAt?: string | null;
  lastPublishAt?: string | null;
  provider?: string;
  connectedPageCount?: number;
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
  controlPanel?: ControlPanelStatus;
};

const MAX_TARGET_PAGES = 100;
const INTERVAL_OPTIONS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" }
] as const;

const defaults: AutoPostConfig = {
  enabled: false,
  contentSource: "shopee-affiliate",
  folderId: "root",
  folderName: "My Drive",
  shopeeSourceTag: "trending",
  shopeeKeyword: "",
  shopeeCategory: "",
  shopeeCaptionStyle: "soft_sell",
  shopeeTrackingId: "",
  shopeeBlockedCategories: [],
  shopeeCategoryPriority: [],
  targetPageIds: [],
  intervalMinutes: 60,
  captionStrategy: "hybrid",
  captions: [],
  hashtags: [],
  aiPrompt: "",
  postingWindowStart: "06:00",
  postingWindowEnd: "00:00",
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
      return JSON.parse(rawText) as { ok?: boolean; message?: string; data?: any; code?: string; warning?: string };
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

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function normalizePagesResponse(payload: any): FacebookPage[] {
  const candidates = [
    payload?.data?.pages,
    payload?.pages,
    payload?.data?.destinations,
    payload?.destinations,
    Array.isArray(payload) ? payload : null
  ];
  const rawPages = candidates.find((value) => Array.isArray(value)) ?? [];
  return rawPages
    .map((page: any) => ({
      pageId: String(page.pageId ?? page.id ?? page.externalPageId ?? ""),
      name: String(page.name ?? page.pageName ?? page.label ?? "Facebook Page")
    }))
    .filter((page: FacebookPage) => page.pageId.length > 0);
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

export function AutoPostPanel() {
  const [config, setConfig] = useState<AutoPostConfig>(defaults);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [logs, setLogs] = useState<StatusLog[]>([]);
  const [controlPanel, setControlPanel] = useState<ControlPanelStatus | null>(null);
  const [panelState, setPanelState] = useState<PanelState>("loading");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [stopping, setStopping] = useState(false);

  const loadStatus = useCallback(async (showLoader = false) => {
    if (showLoader) {
      setLoading(true);
      setPanelState("loading");
    }
    console.info("[auto-post/control-panel] fetch started", { showLoader });

    try {
      const [statusResult, pagesResult] = await Promise.allSettled([
        fetchWithTimeout("/api/auto-post/status", { cache: "no-store" }),
        fetchWithTimeout("/api/facebook/pages", { cache: "no-store" })
      ]);

      const statusJson =
        statusResult.status === "fulfilled"
          ? await readApiResult(statusResult.value)
          : { ok: false, message: statusResult.reason instanceof Error ? statusResult.reason.message : "Unable to load Auto Post status" };
      const pagesJson =
        pagesResult.status === "fulfilled"
          ? await readApiResult(pagesResult.value)
          : { ok: false, message: pagesResult.reason instanceof Error ? pagesResult.reason.message : "Unable to load Facebook pages right now." };

      if (statusJson.ok) {
        const statusData = statusJson.data as StatusResponse;
        setConfig((current) => ({ ...current, ...defaults, ...statusData.config }));
        setLogs((statusData.logs ?? []).slice(0, 10).map((log) => ({ ...log, message: sanitizeText(log.message) })));
        setControlPanel(statusData.controlPanel ?? null);
      } else if (statusJson.message) {
        setError(statusJson.message);
      }

      const parsedPages = pagesJson.ok ? normalizePagesResponse(pagesJson) : [];
      if (parsedPages.length > 0) {
        setPages(parsedPages);
        if (pagesJson.data?.warning || pagesJson.warning) {
          setMessage(String(pagesJson.data?.warning ?? pagesJson.warning));
        }
      } else if (pagesJson.message) {
        setPages([]);
        setError(pagesJson.message);
      }

      const statusState = statusJson.ok ? (statusJson.data as StatusResponse).controlPanel?.state : undefined;
      const nextState: PanelState = !statusJson.ok
        ? "error"
        : statusState === "setup_required"
          ? "setup_required"
          : parsedPages.length === 0
            ? "facebook_required"
            : "ready";
      setPanelState(nextState);
      console.info("[auto-post/control-panel] fetch completed", {
        statusOk: Boolean(statusJson.ok),
        pagesOk: Boolean(pagesJson.ok),
        parsedPagesCount: parsedPages.length,
        responseKeys: pagesJson ? Object.keys(pagesJson) : [],
        state: nextState
      });
    } catch (statusError) {
      const message = statusError instanceof Error ? statusError.message : "Unable to load Auto Post status";
      console.error("[auto-post/control-panel] fetch failed", { message });
      setError(message);
      setPanelState("error");
    } finally {
      setLoading(false);
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
    const response = await fetch("/api/auto-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, enabled: enabledOverride ?? config.enabled })
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
      const response = await fetch("/api/auto-post/start", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to start Auto Post");
      setMessage("Automation started");
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
      const response = await fetch("/api/auto-post/pause", { method: "POST" });
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
      const response = await fetch("/api/auto-post/stop", { method: "POST" });
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

  const visibleState: PanelState = loading ? "loading" : panelState;
  const hasFacebookPages = pages.length > 0;
  const setupRequired = visibleState === "setup_required" || controlPanel?.affiliateConfigStatus === "setup_required";
  const facebookRequired = visibleState === "facebook_required" || !hasFacebookPages;
  const blockingError = visibleState === "error" ? error || "Unable to load Auto Post control panel" : "";

  function renderStateBanner() {
    if (visibleState === "loading") {
      return <div className="composer-message">Loading control panel...</div>;
    }
    if (blockingError) {
      return (
        <div className="composer-message composer-message-error">
          <strong>{blockingError}</strong>
          <button className="button button-secondary" type="button" onClick={() => loadStatus(true)}>Retry</button>
        </div>
      );
    }
    if (setupRequired) {
      return <div className="composer-message">Shopee Affiliate setup required</div>;
    }
    if (facebookRequired) {
      return <div className="composer-message">Connect Facebook Page first</div>;
    }
    return <div className="composer-message">Shopee Affiliate Auto Post is ready.</div>;
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
            Shopee Product Source
            <select
              className="select"
              value={config.shopeeSourceTag}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  contentSource: "shopee-affiliate",
                  shopeeSourceTag: event.target.value as AutoPostConfig["shopeeSourceTag"]
                }))
              }
            >
              <option value="trending">Trending products</option>
              <option value="best_selling">Best-selling products</option>
              <option value="top_search">Top searched products</option>
              <option value="best_roi">Best ROI products</option>
              <option value="manual">Manual keyword search</option>
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
            Keyword
            <input
              className="input"
              value={config.shopeeKeyword}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeKeyword: event.target.value }))}
              placeholder="เช่น ของใช้ในบ้าน, แก้วเก็บความเย็น"
            />
          </label>

          <label className="label">
            Category
            <input
              className="input"
              value={config.shopeeCategory}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeCategory: event.target.value }))}
              placeholder="Lifestyle, Beauty, Home"
            />
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Caption Style
            <select
              className="select"
              value={config.shopeeCaptionStyle}
              onChange={(event) =>
                setConfig((current) => ({ ...current, shopeeCaptionStyle: event.target.value as AutoPostConfig["shopeeCaptionStyle"] }))
              }
            >
              <option value="soft_sell">Soft sell</option>
              <option value="urgency">Urgency</option>
              <option value="problem_solution">Problem-solution</option>
              <option value="review_style">Review style</option>
              <option value="deal_alert">Deal alert</option>
              <option value="lifestyle">Lifestyle</option>
            </select>
          </label>

          <label className="label">
            Tracking ID
            <input
              className="input"
              value={config.shopeeTrackingId}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeTrackingId: event.target.value }))}
              placeholder="Optional affiliate tracking id"
            />
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
            {pages.length ? pages.map((page) => {
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
            }) : <div className="composer-media-empty">Connect Facebook Page first</div>}
          </div>
        </div>

        <label className="label">
          Caption Mode
          <select
            className="select"
            value={config.captionStrategy}
            onChange={(event) => setConfig((current) => ({ ...current, captionStrategy: event.target.value as CaptionStrategy }))}
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
        <div className="muted">Auto Post ตอนนี้ใช้ Shopee Affiliate เป็นแหล่งคอนเทนต์หลัก ไม่ต้องเชื่อม Google Drive เพื่อโพสต์อัตโนมัติแล้ว</div>
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

        {renderStateBanner()}
        {message ? <div className="composer-message">{message}</div> : null}
        {error && !blockingError ? <div className="composer-message composer-message-error">{error}</div> : null}

        <div className="grid cols-2 auto-post-metrics auto-post-metrics-minimal">
          <div className="auto-post-metric-card"><span className="muted">Shopee API status</span><strong>{controlPanel?.shopeeApiStatus ?? "checking"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Affiliate config status</span><strong>{controlPanel?.affiliateConfigStatus ?? "checking"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Facebook Page status</span><strong>{hasFacebookPages ? `connected (${pages.length})` : controlPanel?.facebookPageStatus ?? "missing"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Auto-post engine status</span><strong>{controlPanel?.autoPostEngineStatus ?? statusLabel(config.autoPostStatus)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Last product fetch time</span><strong>{formatDateTime(controlPanel?.lastProductFetchAt ?? undefined)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Last publish time</span><strong>{formatDateTime(controlPanel?.lastPublishAt ?? undefined)}</strong></div>
        </div>

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



