"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/components/language-provider";

type ConnectedPage = {
  pageId: string;
  name: string;
  category?: string;
  profilePictureUrl?: string | null;
};

type AuthUser = {
  id: string;
  email: string;
  name: string;
};

type FacebookOAuthDebug = {
  effectiveScope: string;
  configIdEnabled: boolean;
  configIdSource: string | null;
  explicitScopeConfigured: boolean;
  explicitScopeForced: boolean;
  explicitScopeValue: string | null;
  ignoredLegacyScopePresent: boolean;
  extraScopeConfigured: string | null;
  facebookRedirectUri: string | null;
  facebookAuthRedirectUri: string | null;
  nextPublicAppUrl: string | null;
  facebookLoginConfigIdPresent: boolean;
  facebookLoginUseConfigId: boolean;
  oauthDialogHost: string;
  oauthDialogPath: string;
  oauthDialogScope: string | null;
  oauthDialogRedirectUri: string | null;
};

type FacebookStatusDebug = {
  hasUserFacebookAccount: boolean;
  facebookAccountStatus: string;
  connectedPageCount: number;
  validPageTokenCount: number;
  pagesReturnedByListEndpoint: number;
  responseShape: string;
  expiredCredentialCount: number;
  missingScopeList: string[];
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  lastPagesErrorCode: string | null;
  lastValidatedAt: string | null;
  workspaceIdPresent: boolean;
  userIdPresent: boolean;
};

function extractFacebookPagesPayload(result: any): {
  pages: ConnectedPage[];
  count: number;
  warning: string | null;
  source: string | null;
  responseKeys: string[];
} {
  const responseKeys = result && typeof result === "object" ? Object.keys(result) : [];
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  const rawPages = Array.isArray(data?.pages)
    ? data.pages
    : Array.isArray(data?.destinations)
      ? data.destinations
      : Array.isArray(result?.pages)
        ? result.pages
        : [];

  const pages = rawPages
    .filter((page: any) => page && typeof page === "object")
    .map((page: any) => ({
      pageId: String(page.pageId ?? page.id ?? ""),
      name: String(page.name ?? ""),
      category: page.category ? String(page.category) : undefined,
      profilePictureUrl: page.profilePictureUrl ?? null
    }))
    .filter((page: ConnectedPage) => page.pageId && page.name);

  return {
    pages,
    count: Number(data?.count ?? pages.length),
    warning: typeof data?.warning === "string" ? data.warning : typeof data?.warningCode === "string" ? data.warningCode : null,
    source: typeof data?.source === "string" ? data.source : null,
    responseKeys
  };
}

function mapFacebookMessage(code: string, isThai: boolean) {
  const messages: Record<string, string> = {
    missing_code: isThai
      ? "Facebook ไม่ได้ส่ง authorization code กลับมา กรุณาลองเชื่อมใหม่อีกครั้ง"
      : "Facebook did not return an authorization code.",
    invalid_state: isThai
      ? "รอบการเชื่อม Facebook นี้หมดอายุหรือ state ไม่ตรงกัน กรุณากดเชื่อมใหม่อีกครั้ง"
      : "The Facebook OAuth state was invalid or expired. Please start the connection again.",
    oauth_failed: isThai
      ? "การเชื่อม Facebook ล้มเหลว กรุณาตรวจสิทธิ์ของแอปและลองใหม่อีกครั้ง"
      : "Facebook connection failed. Please review your app permissions and token.",
    unsupported_permission: isThai
      ? "Meta ปฏิเสธสิทธิ์ที่ใช้เชื่อมเพจในรอบนี้ ระบบได้ลดเหลือสิทธิ์ขั้นต่ำแล้ว หากยังไม่ผ่านให้ตรวจ App Review, บทบาทผู้ใช้ในแอป, Business Integrations, App Domains และอย่า reuse LOGIN_CONFIG_ID กับ flow เชื่อมเพจถ้ายังไม่ได้ยืนยันว่า config นั้นมี pages_show_list"
      : "Meta rejected the page permissions requested by this app. Review App Review, app roles, and Business Integrations for the Page.",
    permission_denied: isThai
      ? "บัญชีนี้ยังไม่มีสิทธิ์เชื่อมเพจเข้ากับแอป ลองใช้บัญชีที่เป็น App Admin, Developer หรือ Tester ของแอปเดียวกัน"
      : "This account cannot connect pages to the app yet. Try again with an app admin, developer, or tester account from the same Meta app.",
    invalid_redirect: isThai
      ? "ค่า callback URL ของ Facebook ไม่ตรงกับโดเมน production ปัจจุบัน กรุณาตรวจ Valid OAuth Redirect URIs และ App Domains ให้ใช้โดเมนเดียวกัน"
      : "The Facebook callback URL does not match the current production domain. Verify Valid OAuth Redirect URIs and App Domains use the same domain.",
    missing_config: isThai
      ? "Facebook OAuth ยังตั้งค่าไม่ครบ กรุณาตรวจ FACEBOOK_APP_ID, FACEBOOK_APP_SECRET และ redirect URI ทั้งสองตัว"
      : "Facebook OAuth is not fully configured yet. Check FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and both redirect URIs.",
    login_required: isThai ? "กรุณาเข้าสู่ระบบก่อนเชื่อม Facebook" : "Please sign in before connecting Facebook.",
    facebook_not_connected: isThai ? "Workspace นี้ยังไม่ได้เชื่อม Facebook" : "Facebook is not connected to this workspace yet.",
    token_expired: isThai ? "Facebook token หมดอายุแล้ว กรุณาเชื่อมใหม่อีกครั้ง" : "Facebook token expired. Please reconnect your account.",
    reconnect_required: isThai
      ? "Facebook token ต้องเชื่อมใหม่อีกครั้ง ระบบจะแสดง cached pages ที่มีอยู่ให้ก่อน"
      : "Facebook needs to be reconnected. Cached pages are shown for now.",
    provider_unavailable: isThai
      ? "ตอนนี้ระบบติดต่อ Facebook ไม่ได้ชั่วคราว ระบบจะแสดง cached pages ที่มีอยู่ให้ก่อน"
      : "Facebook is temporarily unavailable. Cached pages are shown for now.",
    destination_disconnected: isThai
      ? "ยังไม่พบเพจที่เชื่อมไว้ในระบบนี้"
      : "No connected Facebook Pages were found for this account.",
    success: isThai ? "เชื่อม Facebook Pages สำเร็จแล้ว" : "Facebook Pages connected successfully."
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

  if (/redirect_uri/i.test(code) || /url blocked/i.test(code) || /invalid_redirect/i.test(code)) {
    return messages.invalid_redirect;
  }

  if (/permission denied/i.test(code) || /developer/i.test(code) || /tester/i.test(code) || /admin/i.test(code)) {
    return messages.permission_denied;
  }

  if (/bad auth/i.test(code) || /authentication failed/i.test(code) || /oauth_failed/i.test(code)) {
    return messages.oauth_failed;
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
  const [disconnecting, setDisconnecting] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [oauthDebug, setOauthDebug] = useState<FacebookOAuthDebug | null>(null);
  const [statusDebug, setStatusDebug] = useState<FacebookStatusDebug | null>(null);

  const queryMessage = useMemo(() => {
    if (searchParams.get("success")) {
      return mapFacebookMessage("success", isThai);
    }

    const error = searchParams.get("error");
    return error ? mapFacebookMessage(error, isThai) : "";
  }, [searchParams, isThai]);

  useEffect(() => {
    let active = true;

    async function load() {
      const meResponse = await fetch("/api/auth/me", { cache: "no-store", credentials: "include" });
      const meResult = await meResponse.json().catch(() => null);

      if (!active) {
        return;
      }

      if (meResult?.ok && meResult.data?.user) {
        setAuthUser(meResult.data.user);
        setMessage(queryMessage);

        const pagesResponse = await fetch("/api/facebook/pages", { cache: "no-store", credentials: "include" });
        const pagesResult = await pagesResponse.json().catch(() => null);

        if (!active) {
          return;
        }

        if (pagesResult?.ok) {
          const parsed = extractFacebookPagesPayload(pagesResult);
          setPages(parsed.pages);
          if (parsed.warning) {
            setMessage(mapFacebookMessage(parsed.warning, isThai));
          }
        } else if (pagesResult?.message) {
          const parsed = extractFacebookPagesPayload(pagesResult);
          if (parsed.pages.length > 0) {
            setPages(parsed.pages);
            if (parsed.warning || pagesResult?.code || pagesResult?.message) {
              setMessage(mapFacebookMessage(parsed.warning || pagesResult.code || pagesResult.message, isThai));
            }
          } else {
          setMessage(mapFacebookMessage(pagesResult.message, isThai));
          }
        }

        const debugResponse = await fetch("/api/facebook/oauth/debug", {
          cache: "no-store",
          credentials: "include"
        });
        const debugResult = await debugResponse.json().catch(() => null);

        if (!active) {
          return;
        }

        if (debugResult?.ok && debugResult.data) {
          setOauthDebug(debugResult.data);
        }

        const statusResponse = await fetch("/api/facebook/debug/status", {
          cache: "no-store",
          credentials: "include"
        });
        const statusResult = await statusResponse.json().catch(() => null);

        if (!active) {
          return;
        }

        if (statusResult?.ok && statusResult.data) {
          setStatusDebug(statusResult.data);
        }
      } else if (meResult?.message === "Unauthorized") {
        setAuthUser(null);
        setPages([]);
        setMessage(mapFacebookMessage("login_required", isThai));
        setOauthDebug(null);
        setStatusDebug(null);
      } else {
        setAuthUser(null);
        setPages([]);
        setOauthDebug(null);
        setStatusDebug(null);
        setMessage(
          meResult?.message ||
            (isThai ? "ยังตรวจสอบ session ของผู้ใช้ไม่สำเร็จ" : "Unable to verify the current user session.")
        );
      }

      setAuthResolved(true);
    }

    load();

    return () => {
      active = false;
    };
  }, [queryMessage, isThai]);

  async function connect() {
    setLoading(true);
    setMessage("");

    const response = await fetch("/api/facebook/oauth/url", { cache: "no-store", credentials: "include" });
    const result = await response.json().catch(() => null);

    if (result?.ok && result.data?.url) {
      window.location.href = result.data.url;
      return;
    }

    setLoading(false);
    const errorCode = result?.message || "login_required";
    setMessage(mapFacebookMessage(errorCode, isThai));
  }

  async function disconnectStaleConnection() {
    setDisconnecting(true);
    setMessage("");

    const response = await fetch("/api/auth/connected-accounts/disconnect", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ provider: "facebook-pages" })
    });

    const result = await response.json().catch(() => null);
    setDisconnecting(false);

    if (result?.ok) {
      setPages([]);
      setMessage(
        isThai
          ? "ล้างการเชื่อม Facebook เดิมแล้ว กรุณากดเชื่อมใหม่อีกครั้ง"
          : "The old Facebook connection has been cleared. Please connect again."
      );
      return;
    }

    setMessage(
      result?.message ||
        (isThai ? "ยังล้างการเชื่อม Facebook เดิมไม่สำเร็จ กรุณาลองอีกครั้ง" : "Unable to clear the Facebook connection.")
    );
  }

  const showPermissionChecklist =
    message.includes("pages_show_list") ||
    message.includes("Business Integrations") ||
    message.includes("Admin, Developer") ||
    message.includes("Meta ปฏิเสธสิทธิ์");
  const showResetConnection =
    /bad auth/i.test(message) ||
    /authentication failed/i.test(message) ||
    /token expired/i.test(message);

  return (
    <div className="stack">
      {!authResolved ? <p className="muted">{isThai ? "กำลังโหลด..." : "Loading..."}</p> : null}

      {authUser ? (
        <p className="muted">
          {isThai ? `เข้าสู่ระบบเป็น ${authUser.name || authUser.email}` : `Signed in as ${authUser.name || authUser.email}`}
        </p>
      ) : authResolved ? (
        <div
          style={{
            border: "1px solid rgba(59, 130, 246, 0.25)",
            background: "rgba(59, 130, 246, 0.06)",
            borderRadius: 16,
            padding: 16,
            display: "flex",
            gap: 12,
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap"
          }}
        >
          <span className="muted">{mapFacebookMessage("login_required", isThai)}</span>
          <Link className="button" href="/login?next=%2Fconnections%2Ffacebook">
            {isThai ? "เข้าสู่ระบบ" : "Sign in"}
          </Link>
        </div>
      ) : null}

      {statusDebug ? (
        <div
          style={{
            border: "1px solid rgba(15, 23, 42, 0.08)",
            background: "rgba(255, 255, 255, 0.72)",
            borderRadius: 16,
            padding: 16,
            display: "grid",
            gap: 6
          }}
        >
          <strong>{isThai ? "สถานะ Facebook ของบัญชีนี้" : "Facebook account status"}</strong>
          <div className="muted" style={{ display: "grid", gap: 4 }}>
            <span>{isThai ? "เชื่อม Facebook Login แล้วหรือไม่" : "Has Facebook login"}: <strong>{statusDebug.hasUserFacebookAccount ? (isThai ? "ใช่" : "Yes") : isThai ? "ไม่" : "No"}</strong></span>
            <span>{isThai ? "สถานะ token" : "Token status"}: <code>{statusDebug.facebookAccountStatus}</code></span>
            <span>{isThai ? "จำนวนเพจที่เชื่อม" : "Connected pages"}: <code>{statusDebug.connectedPageCount}</code></span>
            <span>{isThai ? "จำนวนเพจที่มี page token" : "Pages with page token"}: <code>{statusDebug.validPageTokenCount}</code></span>
            <span>{isThai ? "จำนวนเพจที่ pages endpoint ส่งกลับ" : "Pages returned by pages endpoint"}: <code>{statusDebug.pagesReturnedByListEndpoint}</code></span>
            <span>{isThai ? "response shape ของ pages endpoint" : "Pages endpoint response shape"}: <code>{statusDebug.responseShape}</code></span>
            <span>{isThai ? "สิทธิ์ที่ยังขาด" : "Missing scopes"}: <code>{statusDebug.missingScopeList.join(", ") || "-"}</code></span>
            <span>{isThai ? "รหัส error ล่าสุด" : "Last error code"}: <code>{statusDebug.lastErrorCode || "-"}</code></span>
            <span>{isThai ? "รหัส error ล่าสุดของ pages endpoint" : "Last pages error code"}: <code>{statusDebug.lastPagesErrorCode || "-"}</code></span>
            <span>{isThai ? "มี workspace หรือไม่" : "Workspace present"}: <strong>{statusDebug.workspaceIdPresent ? (isThai ? "มี" : "Yes") : isThai ? "ไม่มี" : "No"}</strong></span>
            <span>{isThai ? "มี userId หรือไม่" : "UserId present"}: <strong>{statusDebug.userIdPresent ? (isThai ? "มี" : "Yes") : isThai ? "ไม่มี" : "No"}</strong></span>
          </div>
        </div>
      ) : null}

      <button className="button" onClick={connect} type="button" disabled={loading || !authUser}>
        {loading ? (isThai ? "กำลังเชื่อม..." : "Connecting...") : t("facebookConnect")}
      </button>

      {message ? <p className="muted">{message}</p> : null}

      {showResetConnection ? (
        <button
          className="button button-ghost"
          onClick={disconnectStaleConnection}
          type="button"
          disabled={disconnecting || !authUser}
        >
          {disconnecting
            ? isThai
              ? "กำลังล้าง..."
              : "Clearing..."
            : isThai
              ? "ล้างการเชื่อม Facebook เดิม"
              : "Clear old Facebook connection"}
        </button>
      ) : null}

      {showPermissionChecklist ? (
        <div
          style={{
            border: "1px solid rgba(245, 158, 11, 0.3)",
            background: "rgba(245, 158, 11, 0.08)",
            borderRadius: 16,
            padding: 16
          }}
        >
          <strong style={{ display: "block", marginBottom: 8 }}>
            {isThai ? "เช็กจุดสำคัญใน Meta" : "Meta checklist"}
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            <li>
              {isThai
                ? "บัญชี Facebook ที่ใช้เชื่อมต้องเป็น App Admin, Developer หรือ Tester ของแอปเดียวกัน"
                : "The same Facebook account must be an App Admin, Developer, or Tester."}
            </li>
            <li>
              {isThai
                ? "ใน Meta App ต้องเพิ่มผลิตภัณฑ์ Facebook Login แล้ว"
                : "Facebook Login must be added to the Meta app."}
            </li>
            <li>
              {isThai
                ? "Business Integrations ต้องอนุญาตเพจที่ต้องการเชื่อมจริง"
                : "Business Integrations must allow the Pages you want to connect."}
            </li>
            <li>
              {isThai
                ? "Valid OAuth Redirect URIs ต้องใช้โดเมน theta ตัวปัจจุบันเท่านั้น"
                : "Valid OAuth Redirect URIs must use the theta production domain only."}
            </li>
            <li>
              {isThai
                ? "App Domains ต้องมี prosocial-app-theta.vercel.app"
                : "App Domains must include prosocial-app-theta.vercel.app."}
            </li>
          </ul>
        </div>
      ) : null}

      {oauthDebug ? (
        <div
          style={{
            border: "1px solid rgba(59, 130, 246, 0.22)",
            background: "rgba(59, 130, 246, 0.05)",
            borderRadius: 16,
            padding: 16,
            display: "grid",
            gap: 10
          }}
        >
          <strong>{isThai ? "สถานะ OAuth ที่ระบบใช้จริงตอนนี้" : "Active OAuth debug state"}</strong>
          <div className="muted" style={{ display: "grid", gap: 4 }}>
            <span>
              {isThai ? "Scope ที่จะขอจริง" : "Effective scope"}: <code>{oauthDebug.oauthDialogScope || oauthDebug.effectiveScope}</code>
            </span>
            <span>
              {isThai ? "ใช้ config_id หรือไม่" : "Using config_id"}:{" "}
              <strong>{oauthDebug.configIdEnabled ? (isThai ? "ใช่" : "Yes") : isThai ? "ไม่" : "No"}</strong>
              {oauthDebug.configIdEnabled && oauthDebug.configIdSource ? (
                <>
                  {" "}
                  (<code>{oauthDebug.configIdSource}</code>)
                </>
              ) : null}
            </span>
            <span>
              {isThai ? "Redirect URI ของ flow เชื่อมเพจ" : "Page connect redirect URI"}:{" "}
              <code>{oauthDebug.oauthDialogRedirectUri || oauthDebug.facebookRedirectUri || "-"}</code>
            </span>
            <span>
              {isThai ? "Redirect URI ของ flow login" : "Login redirect URI"}: <code>{oauthDebug.facebookAuthRedirectUri || "-"}</code>
            </span>
            <span>
              {isThai ? "โดเมนแอปปัจจุบัน" : "Current app URL"}: <code>{oauthDebug.nextPublicAppUrl || "-"}</code>
            </span>
            <span>
              {isThai ? "มี env scope เก่าค้างอยู่ไหม" : "Legacy scope env present"}:{" "}
              <strong>{oauthDebug.ignoredLegacyScopePresent ? (isThai ? "มี แต่ระบบกำลังเมินอยู่" : "Present but ignored") : isThai ? "ไม่มี" : "No"}</strong>
            </span>
            <span>
              {isThai ? "บังคับใช้ scope จาก env หรือไม่" : "Force explicit env scope"}:{" "}
              <strong>{oauthDebug.explicitScopeForced ? (isThai ? "ใช่" : "Yes") : isThai ? "ไม่" : "No"}</strong>
            </span>
            {oauthDebug.explicitScopeForced && oauthDebug.explicitScopeValue ? (
              <span>
                {isThai ? "ค่า scope ที่ถูกบังคับ" : "Forced scope value"}: <code>{oauthDebug.explicitScopeValue}</code>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

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
