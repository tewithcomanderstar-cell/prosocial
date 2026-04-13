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
    unsupported_permission: isThai ? "แอป Facebook ยังไม่มีสิทธิ์ที่รองรับสำหรับการเชื่อมเพจ กรุณาตรวจ App Review, Roles และสิทธิ์ pages_show_list" : "The Facebook app is missing supported permissions for page connection. Review app roles, App Review, and pages_show_list access.",
    permission_denied: isThai ? "บัญชีนี้ยังไม่มีสิทธิ์เชื่อมเพจกับแอป กรุณาลองด้วยบัญชีที่เป็นแอดมินหรือผู้ทดสอบของแอป" : "This account cannot connect pages to the app yet. Try again with an app admin, developer, or tester account.",
    login_required: isThai ? "กรุณาเข้าสู่ระบบในระบบก่อนเชื่อม Facebook" : "Please sign in before connecting Facebook.",
    facebook_not_connected: isThai ? "ยังไม่ได้เชื่อม Facebook กับระบบนี้" : "Facebook is not connected to this workspace yet.",
    token_expired: isThai ? "โทเค็น Facebook หมดอายุ กรุณาเชื่อมใหม่" : "Facebook token expired. Please reconnect your account.",
    success: isThai ? "เชื่อมต่อ Facebook Pages แล้ว" : "Facebook Pages connected successfully."
  };

  if (code === "Please login before connecting Facebook" || code === "UNAUTHORIZED") {
    return messages.login_required;
  }

  if (code === "Facebook is not connected") {
    return messages.facebook_not_connected;
  }

  if (code === "Facebook token expired. Please reconnect your account.") {
    return messages.token_expired;
  }

  if (/supported permission/i.test(code) || /unsupported_permission/i.test(code)) {
    return messages.unsupported_permission;
  }

  if (/permission denied/i.test(code) || /authentication failed/i.test(code) || /bad auth/i.test(code)) {
    return messages.permission_denied;
  }

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
