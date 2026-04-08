"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/language-provider";

type ConnectedPage = {
  pageId: string;
  name: string;
  category?: string;
};

export function FacebookConnectionPanel() {
  const { t } = useI18n();
  const [pages, setPages] = useState<ConnectedPage[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/facebook/pages")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setPages(result.data.pages);
        }
      });
  }, []);

  async function connect() {
    const response = await fetch("/api/facebook/oauth/url");
    const result = await response.json();
    if (result.ok && result.data.url) {
      window.location.href = result.data.url;
      return;
    }

    setMessage(result.message || t("commonRequestFailed"));
  }

  return (
    <div className="stack">
      <button className="button" onClick={connect} type="button">
        {t("facebookConnect")}
      </button>
      {message ? <p className="muted">{message}</p> : null}
      <ul className="list">
        {pages.map((page) => (
          <li key={page.pageId} className="list-item">
            <div>
              <strong>{page.name}</strong>
              <div className="muted">{page.category || t("facebookDefaultCategory")}</div>
            </div>
            <span className="badge">{t("facebookConnected")}</span>
          </li>
        ))}
        {pages.length === 0 ? <li className="list-item">{t("facebookNone")}</li> : null}
      </ul>
    </div>
  );
}
