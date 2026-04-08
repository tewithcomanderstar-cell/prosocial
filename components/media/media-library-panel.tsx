"use client";

import { useEffect, useState } from "react";

type Asset = {
  _id: string;
  title: string;
  type: string;
  category: string;
  caption?: string;
  sourceUrl?: string;
  tags?: string[];
  reuseCount?: number;
};

export function MediaLibraryPanel() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);

  async function load(nextQuery = query, nextCategory = category) {
    const params = new URLSearchParams();
    if (nextQuery) params.set("q", nextQuery);
    if (nextCategory) params.set("category", nextCategory);
    const response = await fetch(`/api/media-library?${params.toString()}`);
    const result = await response.json();
    if (result.ok) {
      setAssets(result.data.assets);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="stack">
      <div className="grid cols-2">
        <input className="input" placeholder="Search content" value={query} onChange={(e) => setQuery(e.target.value)} />
        <input className="input" placeholder="Filter category" value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      <button className="button-secondary" type="button" onClick={() => load(query, category)}>Search</button>
      <div className="grid cols-2">
        {assets.map((asset) => (
          <article key={asset._id} className="card">
            <div className="section-head">
              <div>
                <h2>{asset.title}</h2>
              </div>
              <span className="badge">Reuse {asset.reuseCount ?? 0}</span>
            </div>
            <div className="split">
              <span className="badge badge-neutral">{asset.type}</span>
              <span className="muted">{asset.category}</span>
            </div>
            {asset.caption ? <p>{asset.caption}</p> : null}
            {asset.sourceUrl ? <a className="muted" href={asset.sourceUrl} target="_blank" rel="noreferrer">{asset.sourceUrl}</a> : null}
            <p className="muted">{(asset.tags ?? []).join(" ")}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
