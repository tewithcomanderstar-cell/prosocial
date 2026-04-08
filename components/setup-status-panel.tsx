"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/language-provider";

type SetupStatus = {
  items: Array<{ key: string; label: string; ready: boolean; message: string }>;
  readyCount: number;
  totalCount: number;
};

export function SetupStatusPanel() {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<SetupStatus | null>(null);

  useEffect(() => {
    fetch("/api/system/status")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setStatus(result.data);
        }
      });
  }, []);

  if (!status) {
    return <p className="muted">{t("commonLoading")}</p>;
  }

  const thaiLabels: Record<string, { label: string }> = {
    mongodb: { label: "MongoDB" },
    jwt: { label: "JWT Secret" },
    openai: { label: "OpenAI" },
    facebook: { label: "Facebook OAuth" },
    google: { label: "Google Drive OAuth" },
    cron: { label: "Cron Secret" }
  };

  return (
    <div className="stack">
      <div className="list-item">
        <strong>
          {status.readyCount} / {status.totalCount} {t("setupReady")}
        </strong>
        <span className={status.readyCount === status.totalCount ? "badge" : "badge badge-warn"}>
          {status.readyCount === status.totalCount ? t("setupDone") : t("setupNeeds")}
        </span>
      </div>

      <ul className="list">
        {status.items.map((item) => {
          const localized = language === "th" ? thaiLabels[item.key] : null;

          return (
            <li key={item.key} className="list-item">
              <strong>{localized?.label || item.label}</strong>
              <span className={item.ready ? "badge" : "badge badge-warn"}>
                {item.ready ? t("setupConfigured") : t("setupMissing")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
