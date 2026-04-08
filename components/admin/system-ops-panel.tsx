"use client";

import { useEffect, useState } from "react";

type TokenItem = {
  provider: string;
  connected: boolean;
  status: string;
  expiresAt?: string | null;
};

export function SystemOpsPanel() {
  const [tokens, setTokens] = useState<TokenItem[]>([]);

  useEffect(() => {
    fetch("/api/tokens/status")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setTokens(result.data.tokens);
        }
      });
  }, []);

  return (
    <div className="grid cols-2">
      <section className="card">
        <div className="section-head"><div><h2>Tokens</h2></div></div>
        <div className="list">
          {tokens.map((token) => (
            <div key={token.provider} className="list-item">
              <strong>{token.provider}</strong>
              <span className="badge badge-neutral">{token.status}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-head"><div><h2>Backup</h2></div></div>
        <div className="list">
          <a className="list-item" href="/api/backup/export" target="_blank" rel="noreferrer">
            <strong>Export</strong>
            <span className="badge badge-neutral">JSON</span>
          </a>
          <div className="list-item">
            <strong>Import</strong>
            <span className="badge badge-neutral">Ready</span>
          </div>
        </div>
      </section>
    </div>
  );
}
