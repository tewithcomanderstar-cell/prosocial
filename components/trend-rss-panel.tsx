"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type FacebookPage = { pageId: string; name: string; category?: string };
type TrendConfig = {
  enabled: boolean;
  autoRunEnabled: boolean;
  intervalMinutes: 30 | 60 | 120;
  autoPostEnabled: boolean;
  autoPostIntervalMinutes: 30 | 60 | 120;
  destinationPageIds: string[];
  strategyGoal: "maximize_shares" | "maximize_time_spend" | "maximize_engagement" | "maximize_trust";
  safeDraftMode: boolean;
  templateId?: string | null;
  status?: "idle" | "running" | "waiting" | "failed";
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastScanAt?: string | null;
  nextScanAt?: string | null;
  lastAutoPostAt?: string | null;
  nextAutoPostAt?: string | null;
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

type NewsSource = {
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
  autoPostEnabled: false,
  autoPostIntervalMinutes: 60,
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

function hotLevelLabel(value: string) {
  switch (value) {
    case "surging":
      return "มาแรง";
    case "hot":
      return "ร้อน";
    default:
      return "เริ่มขึ้น";
  }
}

export function TrendRssPanel() {
  const [config, setConfig] = useState<TrendConfig>(defaultConfig);
  const [connectedPages, setConnectedPages] = useState<FacebookPage[]>([]);
  const [trackedPages, setTrackedPages] = useState<TrackedPage[]>([]);
  const [newsSources, setNewsSources] = useState<NewsSource[]>([]);
  const [clusters, setClusters] = useState<ClusterItem[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [newTrackedPage, setNewTrackedPage] = useState({
    pageId: "",
    pageName: "",
    category: ""
  });
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
      const [configRes, pagesRes, trackedRes, sourceRes, clustersRes] = await Promise.all([
        fetch("/api/trend-rss/config", { cache: "no-store" }),
        fetch("/api/facebook/pages", { cache: "no-store" }),
        fetch("/api/trend-rss/pages", { cache: "no-store" }),
        fetch("/api/trend-rss/rss-sources", { cache: "no-store" }),
        fetch("/api/trend-rss/clusters", { cache: "no-store" })
      ]);

      const [configJson, pagesJson, trackedJson, sourceJson, clustersJson] = await Promise.all([
        configRes.json(),
        pagesRes.json(),
        trackedRes.json(),
        sourceRes.json(),
        clustersRes.json()
      ]);

      if (configJson.ok) setConfig({ ...defaultConfig, ...configJson.data.config });
      if (pagesJson.ok) setConnectedPages(pagesJson.data.pages ?? []);
      if (trackedJson.ok) setTrackedPages(trackedJson.data.pages ?? []);
      if (sourceJson.ok) setNewsSources(sourceJson.data.sources ?? []);
      if (clustersJson.ok) setClusters(clustersJson.data.clusters ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดโหมดจับกระแสข่าวไม่สำเร็จ");
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
      setError(result.message || "บันทึกการตั้งค่าไม่สำเร็จ");
      return;
    }
    setMessage(result.message || "บันทึกการตั้งค่าแล้ว");
    await loadAll();
  }

  async function addTrackedPage(payload: { pageId: string; pageName: string; category?: string }) {
    setMessage("");
    setError("");
    const response = await fetch("/api/trend-rss/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageId: payload.pageId.trim(),
        pageName: payload.pageName.trim(),
        category: payload.category?.trim() ?? "",
        priorityWeight: 1,
        trustWeight: 1,
        active: true
      })
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.message || "เพิ่มเพจต้นทางไม่สำเร็จ");
      return;
    }
    setMessage(result.message || "เพิ่มเพจต้นทางแล้ว");
    setNewTrackedPage({ pageId: "", pageName: "", category: "" });
    await loadAll();
  }

  async function removeTrackedPage(id: string) {
    if (!id) return;
    await fetch(`/api/trend-rss/pages/${id}`, { method: "DELETE" });
    await loadAll();
  }

  async function submitTrackedPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newTrackedPage.pageId.trim() || !newTrackedPage.pageName.trim()) {
      setError("กรอก Page ID และชื่อเพจก่อน");
      return;
    }
    await addTrackedPage(newTrackedPage);
  }

  async function addNewsSource(event: FormEvent<HTMLFormElement>) {
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
      setError(result.message || "เพิ่มเว็บข่าวไม่สำเร็จ");
      return;
    }
    setNewSource({
      sourceName: "",
      rssUrl: "",
      category: "",
      trustScore: 70,
      language: "th"
    });
    setMessage(result.message || "เพิ่มเว็บข่าวแล้ว");
    await loadAll();
  }

  async function removeNewsSource(id: string) {
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
      if (!result.ok) throw new Error(result.message || "สแกนกระแสข่าวไม่สำเร็จ");
      setMessage(result.message || "ระบบสแกนกระแสข่าวแล้ว");
      await loadAll();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "สแกนกระแสข่าวไม่สำเร็จ");
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return <div className="muted">กำลังโหลดโหมดจับกระแสข่าว...</div>;
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={saveConfig}>
        <div className="split">
          <div className="stack compact-stack">
            <div className="kicker">Config</div>
            <h3>โหมดจับกระแสข่าวจาก Page ID</h3>
            <div className="muted">
              ระบบจะตามโพสต์จากเพจข่าวที่คุณกรอก Page ID ไว้ ประเมินว่าประเด็นไหนกำลังร้อน แล้วไปหาเว็บข่าวที่คุณเลือกเพื่อสรุปใหม่เป็นสไตล์ของเรา
            </div>
          </div>
          <button className="button button-secondary" type="button" onClick={runNow} disabled={running}>
            {running ? "กำลังสแกน..." : "สแกนกระแสตอนนี้"}
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
          <span>เปิดใช้งานโหมดจับกระแสข่าว</span>
        </label>

        <div className="grid cols-2">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={config.autoRunEnabled}
              onChange={(event) => setConfig((current) => ({ ...current, autoRunEnabled: event.target.checked }))}
            />
            <span>สแกนข่าวอัตโนมัติ</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={config.autoPostEnabled}
              onChange={(event) => setConfig((current) => ({ ...current, autoPostEnabled: event.target.checked }))}
            />
            <span>โพสต์อัตโนมัติเมื่อเจอข่าวที่น่าเล่น</span>
          </label>
        </div>

        <div className="grid cols-2">
          <label className="label">
            รอบสแกนข่าว
            <select
              className="select"
              value={config.intervalMinutes}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  intervalMinutes: Number(event.target.value) as TrendConfig["intervalMinutes"]
                }))
              }
            >
              <option value={30}>ทุก 30 นาที</option>
              <option value={60}>ทุก 1 ชั่วโมง</option>
              <option value={120}>ทุก 2 ชั่วโมง</option>
            </select>
          </label>

          <label className="label">
            รอบโพสต์อัตโนมัติ
            <select
              className="select"
              value={config.autoPostIntervalMinutes}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  autoPostIntervalMinutes: Number(event.target.value) as TrendConfig["autoPostIntervalMinutes"]
                }))
              }
            >
              <option value={30}>ทุก 30 นาที</option>
              <option value={60}>ทุก 1 ชั่วโมง</option>
              <option value={120}>ทุก 2 ชั่วโมง</option>
            </select>
          </label>
        </div>

        <div className="grid cols-2">
          <label className="label">
            เป้าหมายหลักของคอนเทนต์
            <select
              className="select"
              value={config.strategyGoal}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  strategyGoal: event.target.value as TrendConfig["strategyGoal"]
                }))
              }
            >
              <option value="maximize_time_spend">เพิ่มเวลาอ่าน</option>
              <option value="maximize_engagement">เพิ่ม engagement</option>
              <option value="maximize_shares">เพิ่มการแชร์</option>
              <option value="maximize_trust">เพิ่มความน่าเชื่อถือ</option>
            </select>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={config.safeDraftMode}
              onChange={(event) => setConfig((current) => ({ ...current, safeDraftMode: event.target.checked }))}
            />
            <span>โหมดปลอดภัย: สร้าง draft อย่างเดียวก่อน</span>
          </label>
        </div>

        {config.safeDraftMode && config.autoPostEnabled ? (
          <div className="composer-message">
            ตอนนี้เปิดโหมดปลอดภัยอยู่ ระบบจะสร้างดราฟต์ก่อน หากต้องการให้โพสต์อัตโนมัติจริง ให้ปิดโหมดปลอดภัยแล้วบันทึกอีกครั้ง
          </div>
        ) : null}

        <div className="stack compact-stack">
          <div className="split compact-row">
            <strong>เพจปลายทางสำหรับโพสต์ของเรา</strong>
            <span className="muted">{config.destinationPageIds.length} เพจ</span>
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

        <div className="grid cols-4">
          <div className="card">
            <span className="muted">สถานะ</span>
            <strong>{config.status ?? "idle"}</strong>
          </div>
          <div className="card">
            <span className="muted">สแกนล่าสุด</span>
            <strong>{formatDateTime(config.lastScanAt ?? config.lastRunAt)}</strong>
          </div>
          <div className="card">
            <span className="muted">รอบสแกนถัดไป</span>
            <strong>{formatDateTime(config.nextScanAt ?? config.nextRunAt)}</strong>
          </div>
          <div className="card">
            <span className="muted">รอบโพสต์ถัดไป</span>
            <strong>{formatDateTime(config.nextAutoPostAt)}</strong>
          </div>
        </div>

        <button className="button" type="submit">บันทึกโหมดจับกระแสข่าว</button>
      </form>

      <section className="card stack">
        <div className="stack compact-stack">
          <div className="kicker">Trend Source Pages</div>
          <h3>เพจข่าวต้นทางที่ใช้จับกระแส</h3>
          <div className="muted">
            กรอก Page ID และชื่อเพจข่าวที่อยากให้ระบบตาม เช่น เพจข่าวใหญ่ที่มักปล่อยประเด็นไว คุณสามารถใช้ชิปด้านล่างเป็นทางลัดกับเพจที่เชื่อมไว้ในบัญชีนี้ได้ด้วย
          </div>
        </div>

        <form className="grid cols-3" onSubmit={submitTrackedPage}>
          <label className="label">
            Page ID
            <input
              className="input"
              placeholder="เช่น 556983057833319"
              value={newTrackedPage.pageId}
              onChange={(event) => setNewTrackedPage((current) => ({ ...current, pageId: event.target.value }))}
            />
          </label>
          <label className="label">
            ชื่อเพจข่าว
            <input
              className="input"
              placeholder="เช่น ไทยรัฐนิวส์โชว์"
              value={newTrackedPage.pageName}
              onChange={(event) => setNewTrackedPage((current) => ({ ...current, pageName: event.target.value }))}
            />
          </label>
          <label className="label">
            หมวด
            <input
              className="input"
              placeholder="ข่าวทั่วไป / อาชญากรรม / บันเทิง"
              value={newTrackedPage.category}
              onChange={(event) => setNewTrackedPage((current) => ({ ...current, category: event.target.value }))}
            />
          </label>
          <div className="label">
            <span> </span>
            <button className="button" type="submit">เพิ่มเพจต้นทาง</button>
          </div>
        </form>

        <div className="stack compact-stack">
          <div className="muted">ทางลัดจากเพจที่เชื่อมไว้</div>
          <div className="chip-grid">
            {connectedPages.map((page) => (
              <button
                key={page.pageId}
                type="button"
                className={`choice-chip ${trackedPageIds.has(page.pageId) ? "active" : ""}`}
                onClick={() =>
                  trackedPageIds.has(page.pageId)
                    ? removeTrackedPage(trackedPages.find((item) => item.pageId === page.pageId)?._id ?? "")
                    : addTrackedPage({
                        pageId: page.pageId,
                        pageName: page.name,
                        category: page.category ?? ""
                      })
                }
              >
                {page.name}
              </button>
            ))}
          </div>
        </div>

        <div className="stack compact-stack">
          {trackedPages.length ? (
            trackedPages.map((page) => (
              <div key={page._id} className="split compact-row card">
                <div className="stack compact-stack">
                  <strong>{page.pageName}</strong>
                  <span className="muted">Page ID: {page.pageId}</span>
                  <span className="muted">
                    หมวด {page.category || "-"} • weight {page.priorityWeight} • trust {page.trustWeight}
                  </span>
                </div>
                <button className="button button-secondary" type="button" onClick={() => removeTrackedPage(page._id)}>
                  ลบ
                </button>
              </div>
            ))
          ) : (
            <div className="muted">ยังไม่ได้เพิ่มเพจข่าวต้นทาง</div>
          )}
        </div>
      </section>

      <section className="card stack">
        <div className="stack compact-stack">
          <div className="kicker">News Sites</div>
          <h3>เว็บข่าวที่ใช้ยืนยันข้อเท็จจริง</h3>
          <div className="muted">
            ระบบจะไม่เขียนจากโพสต์เพจอย่างเดียว แต่จะเอาประเด็นไปหาเว็บข่าวที่คุณใส่ไว้ เพื่อแตกประเด็นและสรุปใหม่เป็นแบบของเรา
          </div>
        </div>

        <form className="grid cols-2" onSubmit={addNewsSource}>
          <label className="label">
            ชื่อเว็บข่าว
            <input
              className="input"
              value={newSource.sourceName}
              onChange={(event) => setNewSource((current) => ({ ...current, sourceName: event.target.value }))}
            />
          </label>
          <label className="label">
            RSS URL / feed URL
            <input
              className="input"
              value={newSource.rssUrl}
              onChange={(event) => setNewSource((current) => ({ ...current, rssUrl: event.target.value }))}
            />
          </label>
          <label className="label">
            หมวด
            <input
              className="input"
              value={newSource.category}
              onChange={(event) => setNewSource((current) => ({ ...current, category: event.target.value }))}
            />
          </label>
          <label className="label">
            Trust Score
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={newSource.trustScore}
              onChange={(event) =>
                setNewSource((current) => ({ ...current, trustScore: Number(event.target.value) || 0 }))
              }
            />
          </label>
          <label className="label">
            ภาษา
            <select
              className="select"
              value={newSource.language}
              onChange={(event) =>
                setNewSource((current) => ({ ...current, language: event.target.value as "th" | "en" }))
              }
            >
              <option value="th">ไทย</option>
              <option value="en">อังกฤษ</option>
            </select>
          </label>
          <div className="label">
            <span> </span>
            <button className="button" type="submit">เพิ่มเว็บข่าว</button>
          </div>
        </form>

        <div className="stack compact-stack">
          {newsSources.length ? (
            newsSources.map((source) => (
              <div key={source._id} className="split compact-row card">
                <div className="stack compact-stack">
                  <strong>{source.sourceName}</strong>
                  <span className="muted">{source.rssUrl}</span>
                  <span className="muted">
                    trust {source.trustScore} • {source.language} • {source.category || "ทั่วไป"}
                  </span>
                </div>
                <button className="button button-secondary" type="button" onClick={() => removeNewsSource(source._id)}>
                  ลบ
                </button>
              </div>
            ))
          ) : (
            <div className="muted">ยังไม่มีเว็บข่าวสำหรับยืนยันประเด็น</div>
          )}
        </div>
      </section>

      <section className="card stack">
        <div className="stack compact-stack">
          <div className="kicker">Trend Radar</div>
          <h3>ประเด็นที่กำลังมาแรง</h3>
          <div className="muted">
            ระบบจะประเมินจากความเร็วของยอด reaction, comment, share แล้วจับเป็นกลุ่มหัวข้อ เพื่อคัดว่าประเด็นไหนกำลังจะไวรัล
          </div>
        </div>
        <div className="stack compact-stack">
          {clusters.length ? (
            clusters.map((cluster) => (
              <article key={cluster._id} className="card stack compact-stack">
                <div className="split compact-row">
                  <strong>{cluster.label}</strong>
                  <span className="badge badge-neutral">{hotLevelLabel(cluster.hotLevel)}</span>
                </div>
                <div className="muted">{cluster.summary}</div>
                <div className="muted">
                  score {cluster.trendScore} • สถานะ {cluster.status} • ความมั่นใจข่าว {cluster.resolution?.confidenceScore ?? "-"}
                </div>
                <div className="muted">{cluster.relatedEntities.join(", ")}</div>
              </article>
            ))
          ) : (
            <div className="muted">ยังไม่มีประเด็นข่าว ให้กด “สแกนกระแสตอนนี้” ก่อน</div>
          )}
        </div>
      </section>
    </div>
  );
}
