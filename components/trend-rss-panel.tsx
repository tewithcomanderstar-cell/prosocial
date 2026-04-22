"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type FacebookPage = { pageId: string; name: string; category?: string };
type TrendConfig = {
  enabled: boolean;
  autoRunEnabled: boolean;
  intervalMinutes: 15 | 30 | 60 | 120;
  destinationPageIds: string[];
  strategyGoal: "maximize_shares" | "maximize_time_spend" | "maximize_engagement" | "maximize_trust";
  safeDraftMode: boolean;
  templateId?: string | null;
  status?: "idle" | "running" | "waiting" | "failed";
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string | null;
};

type TrackedPage = {
  _id: string;
  pageId: string;
  pageName: string;
  category?: string;
  priorityWeight: number;
  trustWeight: number;
  active: boolean;
};

type RssSource = {
  _id: string;
  sourceName: string;
  rssUrl: string;
  category?: string;
  trustScore: number;
  language: "th" | "en";
  active: boolean;
};

type ClusterItem = {
  _id: string;
  label: string;
  summary: string;
  trendScore: number;
  hotLevel: string;
  status: string;
  relatedEntities: string[];
  resolution?: {
    confidenceScore?: number;
  } | null;
};

const defaultConfig: TrendConfig = {
  enabled: false,
  autoRunEnabled: false,
  intervalMinutes: 60,
  destinationPageIds: [],
  strategyGoal: "maximize_time_spend",
  safeDraftMode: true,
  templateId: null,
  status: "idle"
};

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("th-TH");
}

export function TrendRssPanel() {
  const [config, setConfig] = useState<TrendConfig>(defaultConfig);
  const [connectedPages, setConnectedPages] = useState<FacebookPage[]>([]);
  const [trackedPages, setTrackedPages] = useState<TrackedPage[]>([]);
  const [rssSources, setRssSources] = useState<RssSource[]>([]);
  const [clusters, setClusters] = useState<ClusterItem[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [newSource, setNewSource] = useState({
    sourceName: "",
    rssUrl: "",
    category: "",
    trustScore: 70,
    language: "th" as "th" | "en"
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [configRes, pagesRes, trackedRes, rssRes, clustersRes] = await Promise.all([
        fetch("/api/trend-rss/config", { cache: "no-store" }),
        fetch("/api/facebook/pages", { cache: "no-store" }),
        fetch("/api/trend-rss/pages", { cache: "no-store" }),
        fetch("/api/trend-rss/rss-sources", { cache: "no-store" }),
        fetch("/api/trend-rss/clusters", { cache: "no-store" })
      ]);

      const [configJson, pagesJson, trackedJson, rssJson, clustersJson] = await Promise.all([
        configRes.json(),
        pagesRes.json(),
        trackedRes.json(),
        rssRes.json(),
        clustersRes.json()
      ]);

      if (configJson.ok) setConfig({ ...defaultConfig, ...configJson.data.config });
      if (pagesJson.ok) setConnectedPages(pagesJson.data.pages ?? []);
      if (trackedJson.ok) setTrackedPages(trackedJson.data.pages ?? []);
      if (rssJson.ok) setRssSources(rssJson.data.sources ?? []);
      if (clustersJson.ok) setClusters(clustersJson.data.clusters ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "?????????????????????");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const trackedPageIds = useMemo(() => new Set(trackedPages.map((page) => page.pageId)), [trackedPages]);

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    const response = await fetch("/api/trend-rss/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.message || "?????????????????????????");
      return;
    }
    setMessage(result.message || "????????????????????");
    await loadAll();
  }

  async function addTrackedPage(page: FacebookPage) {
    setMessage("");
    setError("");
    const response = await fetch("/api/trend-rss/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageId: page.pageId,
        pageName: page.name,
        category: page.category ?? "",
        priorityWeight: 1,
        trustWeight: 1,
        active: true
      })
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.message || "???????????????????????");
      return;
    }
    setMessage(result.message || "??????????????????");
    await loadAll();
  }

  async function removeTrackedPage(id: string) {
    if (!id) return;
    await fetch(`/api/trend-rss/pages/${id}`, { method: "DELETE" });
    await loadAll();
  }

  async function addRssSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    const response = await fetch("/api/trend-rss/rss-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSource)
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.message || "????? RSS source ?????????");
      return;
    }
    setNewSource({
      sourceName: "",
      rssUrl: "",
      category: "",
      trustScore: 70,
      language: "th"
    });
    setMessage(result.message || "????? RSS source ????");
    await loadAll();
  }

  async function removeRssSource(id: string) {
    if (!id) return;
    await fetch(`/api/trend-rss/rss-sources/${id}`, { method: "DELETE" });
    await loadAll();
  }

  async function runNow() {
    setRunning(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/trend-rss/run", { method: "POST" });
      const result = await response.json();
      if (!result.ok) throw new Error(result.message || "????????????????????");
      setMessage(result.message || "??? pipeline ????");
      await loadAll();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "????????????????????");
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return <div className="muted">??????????????????????...</div>;
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={saveConfig}>
        <div className="split">
          <div className="stack compact-stack">
            <div className="kicker">Config</div>
            <h3>???????? RSS</h3>
          </div>
          <button className="button button-secondary" type="button" onClick={runNow} disabled={running}>
            {running ? "????????..." : "??????????????"}
          </button>
        </div>

        {message ? <div className="composer-message">{message}</div> : null}
        {error ? <div className="composer-message composer-message-error">{error}</div> : null}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.checked }))}
          />
          <span>???????????????????????</span>
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={config.autoRunEnabled}
            onChange={(event) => setConfig((current) => ({ ...current, autoRunEnabled: event.target.checked }))}
          />
          <span>?????????????????</span>
        </label>

        <div className="grid cols-2">
          <label className="label">
            ???
            <select
              className="select"
              value={config.intervalMinutes}
              onChange={(event) =>
                setConfig((current) => ({ ...current, intervalMinutes: Number(event.target.value) as TrendConfig["intervalMinutes"] }))
              }
            >
              <option value={15}>15 ????</option>
              <option value={30}>30 ????</option>
              <option value={60}>1 ???????</option>
              <option value={120}>2 ???????</option>
            </select>
          </label>

          <label className="label">
            ????????????
            <select
              className="select"
              value={config.strategyGoal}
              onChange={(event) =>
                setConfig((current) => ({ ...current, strategyGoal: event.target.value as TrendConfig["strategyGoal"] }))
              }
            >
              <option value="maximize_time_spend">?????????????</option>
              <option value="maximize_engagement">????? engagement</option>
              <option value="maximize_shares">????????????</option>
              <option value="maximize_trust">????????????????????</option>
            </select>
          </label>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={config.safeDraftMode}
            onChange={(event) => setConfig((current) => ({ ...current, safeDraftMode: event.target.checked }))}
          />
          <span>???????????: ????? draft / needs review ???????????????</span>
        </label>

        <div className="stack compact-stack">
          <div className="split compact-row">
            <strong>???????????????? draft</strong>
            <span className="muted">{config.destinationPageIds.length} ???</span>
          </div>
          <div className="chip-grid">
            {connectedPages.map((page) => {
              const active = config.destinationPageIds.includes(page.pageId);
              return (
                <button
                  key={page.pageId}
                  type="button"
                  className={`choice-chip ${active ? "active" : ""}`}
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      destinationPageIds: active
                        ? current.destinationPageIds.filter((pageId) => pageId !== page.pageId)
                        : [...current.destinationPageIds, page.pageId]
                    }))
                  }
                >
                  {page.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid cols-3">
          <div className="card">
            <span className="muted">?????</span>
            <strong>{config.status ?? "idle"}</strong>
          </div>
          <div className="card">
            <span className="muted">?????????</span>
            <strong>{formatDateTime(config.lastRunAt)}</strong>
          </div>
          <div className="card">
            <span className="muted">????????</span>
            <strong>{formatDateTime(config.nextRunAt)}</strong>
          </div>
        </div>

        <button className="button" type="submit">??????????????</button>
      </form>

      <section className="card stack">
        <div className="stack compact-stack">
          <div className="kicker">Facebook Trend Sources</div>
          <h3>??????????????????</h3>
        </div>
        <div className="chip-grid">
          {connectedPages.map((page) => (
            <button
              key={page.pageId}
              type="button"
              className={`choice-chip ${trackedPageIds.has(page.pageId) ? "active" : ""}`}
              onClick={() =>
                trackedPageIds.has(page.pageId)
                  ? removeTrackedPage(trackedPages.find((item) => item.pageId === page.pageId)?._id ?? "")
                  : addTrackedPage(page)
              }
            >
              {page.name}
            </button>
          ))}
        </div>
        <div className="stack compact-stack">
          {trackedPages.length ? trackedPages.map((page) => (
            <div key={page._id} className="split compact-row card">
              <div className="stack compact-stack">
                <strong>{page.pageName}</strong>
                <span className="muted">
                  weight {page.priorityWeight} / trust {page.trustWeight} / {page.active ? "active" : "paused"}
                </span>
              </div>
              <button className="button button-secondary" type="button" onClick={() => removeTrackedPage(page._id)}>
                ??
              </button>
            </div>
          )) : <div className="muted">???????????????????????????</div>}
        </div>
      </section>

      <section className="card stack">
        <div className="stack compact-stack">
          <div className="kicker">RSS Registry</div>
          <h3>????? RSS</h3>
        </div>
        <form className="grid cols-2" onSubmit={addRssSource}>
          <label className="label">
            ?????????????
            <input className="input" value={newSource.sourceName} onChange={(event) => setNewSource((current) => ({ ...current, sourceName: event.target.value }))} />
          </label>
          <label className="label">
            RSS URL
            <input className="input" value={newSource.rssUrl} onChange={(event) => setNewSource((current) => ({ ...current, rssUrl: event.target.value }))} />
          </label>
          <label className="label">
            ????
            <input className="input" value={newSource.category} onChange={(event) => setNewSource((current) => ({ ...current, category: event.target.value }))} />
          </label>
          <label className="label">
            Trust Score
            <input className="input" type="number" min={0} max={100} value={newSource.trustScore} onChange={(event) => setNewSource((current) => ({ ...current, trustScore: Number(event.target.value) || 0 }))} />
          </label>
          <label className="label">
            ????
            <select className="select" value={newSource.language} onChange={(event) => setNewSource((current) => ({ ...current, language: event.target.value as "th" | "en" }))}>
              <option value="th">???</option>
              <option value="en">??????</option>
            </select>
          </label>
          <div className="label">
            <span> </span>
            <button className="button" type="submit">????? RSS source</button>
          </div>
        </form>
        <div className="stack compact-stack">
          {rssSources.length ? rssSources.map((source) => (
            <div key={source._id} className="split compact-row card">
              <div className="stack compact-stack">
                <strong>{source.sourceName}</strong>
                <span className="muted">{source.rssUrl}</span>
                <span className="muted">trust {source.trustScore} / {source.language}</span>
              </div>
              <button className="button button-secondary" type="button" onClick={() => removeRssSource(source._id)}>
                ??
              </button>
            </div>
          )) : <div className="muted">???????? RSS source</div>}
        </div>
      </section>

      <section className="card stack">
        <div className="stack compact-stack">
          <div className="kicker">Topic Clusters</div>
          <h3>????????????????????</h3>
        </div>
        <div className="stack compact-stack">
          {clusters.length ? clusters.map((cluster) => (
            <article key={cluster._id} className="card stack compact-stack">
              <div className="split compact-row">
                <strong>{cluster.label}</strong>
                <span className="badge badge-neutral">{cluster.hotLevel}</span>
              </div>
              <div className="muted">{cluster.summary}</div>
              <div className="muted">
                score {cluster.trendScore} • status {cluster.status} • confidence {cluster.resolution?.confidenceScore ?? "-"}
              </div>
              <div className="muted">{cluster.relatedEntities.join(", ")}</div>
            </article>
          )) : <div className="muted">????????????????????? ????? “??????????????” ????</div>}
        </div>
      </section>
    </div>
  );
}
