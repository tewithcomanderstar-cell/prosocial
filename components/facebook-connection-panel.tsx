"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/components/language-provider";

type ConnectedPage = {
  pageId: string;
  name: string;
  category?: string;
};

type AuthUser = {
  id: string;
  email: string;
  name: string;
};

function mapFacebookMessage(code: string, isThai: boolean) {
  const messages: Record<string, string> = {
    missing_code: isThai
      ? "Facebook did not return an authorization code. Please try connecting again."
      : "Facebook did not return an authorization code.",
    oauth_failed: isThai
      ? "Facebook connection failed. Please review the app token and permissions."
      : "Facebook connection failed. Please review your app permissions and token.",
    unsupported_permission: isThai
      ? "This Facebook app still cannot use pages_show_list in its current Meta setup. Review app roles, Facebook Login, and Pages access in Business Integrations."
      : "This Facebook app still cannot use pages_show_list in its current Meta setup. Review app roles, Facebook Login, and Pages access in Business Integrations.",
    permission_denied: isThai
      ? "This account cannot connect pages to the app yet. Try again with an app admin, developer, or tester account from the same Meta app."
      : "This account cannot connect pages to the app yet. Try again with an app admin, developer, or tester account from the same Meta app.",
    invalid_redirect: isThai
      ? "The Facebook callback URL does not match the current production domain. Verify Valid OAuth Redirect URIs and App Domains use the same domain."
      : "The Facebook callback URL does not match the current production domain. Verify Valid OAuth Redirect URIs and App Domains use the same domain.",
    missing_config: isThai
      ? "Facebook OAuth is not fully configured yet. Check FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and both redirect URIs."
      : "Facebook OAuth is not fully configured yet. Check FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and both redirect URIs.",
    login_required: isThai ? "Please sign in before connecting Facebook." : "Please sign in before connecting Facebook.",
    facebook_not_connected: isThai ? "Facebook is not connected to this workspace yet." : "Facebook is not connected to this workspace yet.",
    token_expired: isThai ? "Facebook token expired. Please reconnect your account." : "Facebook token expired. Please reconnect your account.",
    success: isThai ? "Facebook Pages connected successfully." : "Facebook Pages connected successfully."
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
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authResolved, setAuthResolved] = useState(false);

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
          setPages(pagesResult.data.pages);
        } else if (pagesResult?.message) {
          setMessage(mapFacebookMessage(pagesResult.message, isThai));
        }
      } else if (meResult?.message === "Unauthorized") {
        setAuthUser(null);
        setPages([]);
        setMessage(mapFacebookMessage("login_required", isThai));
      } else {
        setAuthUser(null);
        setPages([]);
        setMessage(meResult?.message || (isThai ? "Unable to verify current user session." : "Unable to verify the current user session."));
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

  const showPermissionChecklist =
    message.includes("pages_show_list") ||
    message.includes("Business Integrations") ||
    message.includes("admin, developer, or tester");

  return (
    <div className="stack">
      {!authResolved ? <p className="muted">Loading...</p> : null}

      {authUser ? (
        <p className="muted">Signed in as {authUser.name || authUser.email}</p>
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
            Sign in
          </Link>
        </div>
      ) : null}

      <button className="button" onClick={connect} type="button" disabled={loading || !authUser}>
        {loading ? "Connecting..." : t("facebookConnect")}
      </button>

      {message ? <p className="muted">{message}</p> : null}

      {showPermissionChecklist ? (
        <div
          style={{
            border: "1px solid rgba(245, 158, 11, 0.3)",
            background: "rgba(245, 158, 11, 0.08)",
            borderRadius: 16,
            padding: 16
          }}
        >
          <strong style={{ display: "block", marginBottom: 8 }}>Meta checklist</strong>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            <li>The same Facebook account must be an App Admin, Developer, or Tester.</li>
            <li>Facebook Login must be added to the Meta app.</li>
            <li>Business Integrations must allow the Pages you want to connect.</li>
            <li>Valid OAuth Redirect URIs must use the theta production domain only.</li>
            <li>App Domains must include prosocial-app-theta.vercel.app.</li>
          </ul>
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
