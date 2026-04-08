"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

type ConnectedAccount = {
  id: string;
  name: string;
  kind: "social" | "integration";
  provider: "facebook" | "google";
  connected: boolean;
  detail: string | null;
  connectedAt: string | null;
  reconnectUrl: string;
  tokenStatus?: string;
};

export default function ConnectedAccountsPage() {
  const { language } = useI18n();
  const isThai = language === "th";
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const copy = useMemo(
    () => ({
      title: isThai ? "บัญชีที่เชื่อมต่อ" : "Connected Accounts",
      loading: isThai ? "กำลังโหลด..." : "Loading...",
      reconnect: isThai ? "เชื่อมต่อใหม่" : "Reconnect",
      disconnect: isThai ? "ยกเลิกการเชื่อมต่อ" : "Disconnect",
      connected: isThai ? "เชื่อมต่อแล้ว" : "Connected",
      notConnected: isThai ? "ยังไม่เชื่อมต่อ" : "Not connected",
      social: isThai ? "เข้าสู่ระบบ" : "Login",
      integration: isThai ? "การเชื่อมต่อ" : "Integration",
      lastSync: isThai ? "เชื่อมต่อล่าสุด" : "Last connected",
      token: isThai ? "สถานะโทเคน" : "Token status",
      disconnected: isThai ? "ยกเลิกการเชื่อมต่อแล้ว" : "Disconnected"
    }),
    [isThai]
  );

  async function loadAccounts() {
    setLoading(true);
    const response = await fetch("/api/auth/connected-accounts", { cache: "no-store" });
    const result = await response.json();
    setLoading(false);

    if (!result.ok) {
      setMessage(result.message || (isThai ? "ไม่สามารถโหลดบัญชีที่เชื่อมต่อได้" : "Unable to load connected accounts"));
      return;
    }

    setAccounts(result.data.accounts);
  }

  useEffect(() => {
    loadAccounts();
  }, [isThai]);

  async function handleReconnect(account: ConnectedAccount) {
    setBusyId(account.id);
    setMessage("");

    if (account.kind === "integration") {
      const response = await fetch(account.reconnectUrl, { cache: "no-store" });
      const result = await response.json();
      setBusyId(null);

      if (!result.ok || !result.data?.url) {
        setMessage(result.message || (isThai ? "ไม่สามารถเริ่มเชื่อมต่อใหม่ได้" : "Unable to reconnect account"));
        return;
      }

      window.location.href = result.data.url;
      return;
    }

    window.location.href = account.reconnectUrl;
  }

  async function handleDisconnect(account: ConnectedAccount) {
    setBusyId(account.id);
    setMessage("");

    const response = await fetch("/api/auth/connected-accounts/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: account.id })
    });

    const result = await response.json();
    setBusyId(null);

    if (!result.ok) {
      setMessage(result.message || (isThai ? "ยกเลิกการเชื่อมต่อไม่สำเร็จ" : "Unable to disconnect account"));
      return;
    }

    setMessage(result.message || copy.disconnected);
    loadAccounts();
  }

  return (
    <div className="stack">
      <SectionCard title={copy.title} icon="accounts">
        {loading ? <div className="muted">{copy.loading}</div> : null}

        {!loading ? (
          <div className="connected-grid">
            {accounts.map((account) => (
              <section key={account.id} className="connected-card">
                <div className="split">
                  <div className="stack">
                    <strong>{account.name}</strong>
                    <span className="muted">{account.kind === "social" ? copy.social : copy.integration}</span>
                  </div>
                  <span className={`badge ${account.connected ? "" : "badge-neutral"}`}>
                    {account.connected ? copy.connected : copy.notConnected}
                  </span>
                </div>

                <div className="connected-meta">
                  {account.detail ? <div className="muted">{account.detail}</div> : null}
                  {account.connectedAt ? (
                    <div className="muted">
                      {copy.lastSync}: {new Date(account.connectedAt).toLocaleString()}
                    </div>
                  ) : null}
                  {account.tokenStatus ? (
                    <div className="muted">
                      {copy.token}: {account.tokenStatus}
                    </div>
                  ) : null}
                </div>

                <div className="connected-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => handleReconnect(account)}
                    disabled={busyId === account.id}
                  >
                    {copy.reconnect}
                  </button>

                  {account.kind === "integration" && account.connected ? (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => handleDisconnect(account)}
                      disabled={busyId === account.id}
                    >
                      {copy.disconnect}
                    </button>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {message ? <div className="composer-message">{message}</div> : null}
      </SectionCard>
    </div>
  );
}
