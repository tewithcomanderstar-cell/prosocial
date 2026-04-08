"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/components/language-provider";

type ConnectedPage = {
  pageId: string;
  name: string;
  category?: string;
};

function mapFacebookMessage(code: string, isThai: boolean) {
  const messages: Record<string, string> = {
    missing_code: isThai ? "Facebook ไม่ส่ง code กลับมา กรุณาลองเชื่อมต่อใหม่" : "Facebook did not return an authorization code.",
    oauth_failed: isThai ? "เชื่อมต่อ Facebook ไม่สำเร็จ กรุณาตรวจ token และสิทธิ์ของแอป" : "Facebook connection failed. Please review your app permissions and token.",
    success: isThai ? "เชื่อมต่อ Facebook Pages แล้ว" : "Facebook Pages connected successfully."
  };

  return messages[code] || code;
}

export function FacebookConnectionPanel() {
  const { t, language } = useI18n();
  const isThai = language === "th";
  const searchParams = useSearchParams();
  const [pages, setPages] = useState<ConnectedPage[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const queryMessage = useMemo(() => {
    if (searchParams.get("success")) {
      return mapFacebookMessage("success", isThai);
    }

    const error = searchParams.get("error");
    return error ? mapFacebookMessage(error, isThai) : "";
  }, [searchParams, isThai]);

  useEffect(() => {
    setMessage(queryMessage);
    fetch("/api/facebook/pages")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setPages(result.data.pages);
        } else if (result.message) {
          setMessage(mapFacebookMessage(result.message, isThai));
        }
      });
  }, [queryMessage, isThai]);

  async function connect() {
    setLoading(true);
    const response = await fetch("/api/facebook/oauth/url");
    const result = await response.json();
    if (result.ok && result.data.url) {
      window.location.href = result.data.url;
      return;
    }

    setLoading(false);
    setMessage(result.message || t("commonRequestFailed"));
  }

  return (
    <div className="stack">
      <button className="button" onClick={connect} type="button" disabled={loading}>
        {loading ? (isThai ? "กำลังเชื่อมต่อ..." : "Connecting...") : t("facebookConnect")}
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
