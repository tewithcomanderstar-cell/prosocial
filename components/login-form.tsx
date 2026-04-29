"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppIcon } from "@/components/app-icon";
import { useI18n } from "@/components/language-provider";

function mapAuthMessage(code: string, isThai: boolean) {
  const messages: Record<string, string> = {
    missing_google_oauth: isThai ? "???? Google Login ?????????????????? environment variables" : "Google Login is not configured yet.",
    missing_facebook_oauth: isThai ? "???? Facebook Login ?????????????????? environment variables" : "Facebook Login is not configured yet.",
    invalid_google_state: isThai ? "?????????????????????? Google ?????????? ????????????" : "Invalid Google OAuth state. Please try again.",
    invalid_facebook_state: isThai ? "?????????????????????? Facebook ?????????? ????????????" : "Invalid Facebook OAuth state. Please try again.",
    google_token_exchange_failed: isThai ? "Google ??? token ????????? ???????? login ????" : "Google token exchange failed. Please try again.",
    facebook_token_exchange_failed: isThai ? "Facebook ??? token ????????? ???????? login ????" : "Facebook token exchange failed. Please try again.",
    google_profile_failed: isThai ? "????????????????????????? Google ???" : "Unable to load Google profile.",
    facebook_profile_failed: isThai ? "????????????????????????? Facebook ???" : "Unable to load Facebook profile.",
    auth_storage_unavailable: isThai ? "?????????????????????????????????????? ????????????????????????????????" : "The database is temporarily unavailable. Please try again shortly.",
    session_config_error: isThai ? "???? session ????????????????????????????????? ???????????? JWT_SECRET" : "Session configuration is incomplete. Please verify JWT_SECRET.",
    google_login_failed: isThai ? "Google Login ??????? ????????????" : "Google login failed. Please try again.",
    facebook_login_failed: isThai ? "Facebook Login ??????? ????????????" : "Facebook login failed. Please try again.",
    unsupported_permission: isThai ? "??? Facebook ??????????????????????????? ???????????? Login Configuration ??? App Review" : "The Facebook app is missing required permissions. Review Login Configuration and app permissions.",
    unauthorized: isThai ? "??????????????????????????" : "Please sign in before continuing."
  };

  return messages[code] || code;
}

type LoginFormProps = {
  initialMode?: "login" | "register";
};

export function LoginForm({ initialMode = "login" }: LoginFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { language, t } = useI18n();
  const isThai = language === "th";
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<"google" | "facebook" | null>(null);

  const nextPath = useMemo(() => searchParams.get("next") || "/dashboard", [searchParams]);

  const mappedError = useMemo(() => {
    const error = searchParams.get("error") || "";
    return error ? mapAuthMessage(error, isThai) : "";
  }, [searchParams, isThai]);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    setMessage(mappedError);
  }, [mappedError]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const formData = new FormData(event.currentTarget);
    const payload = {
      name: String(formData.get("name") || ""),
      email: String(formData.get("email") || ""),
      password: String(formData.get("password") || "")
    };

    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    setLoading(false);
    setMessage(result.message || (result.ok ? t("commonSuccess") : t("commonRequestFailed")));

    if (result.ok) {
      const sessionResponse = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "include"
      });
      const sessionResult = await sessionResponse.json().catch(() => null);

      if (sessionResult?.ok) {
        router.push(nextPath);
        router.refresh();
        return;
      }

      setMessage(
        sessionResult?.message ||
          (isThai
            ? "????????? session ???????????? ???????????????????????????????"
            : "The app could not establish your session. Please try signing in again.")
      );
    }
  }

  function startSocialLogin(provider: "google" | "facebook") {
    setSocialLoading(provider);
    window.location.href = `/api/auth/${provider}/start?next=${encodeURIComponent(nextPath)}`;
  }

  return (
    <form className="form auth-form" onSubmit={handleSubmit}>
      <div className="auth-form-head">
        <div>
          <div className="auth-form-kicker">{isThai ? "???????????" : "User access"}</div>
          <h2 className="auth-form-title">{mode === "login" ? t("loginSignIn") : t("loginCreate")}</h2>
        </div>
        <div className="auth-mode-toggle" role="tablist" aria-label={isThai ? "?????????????" : "Account mode"}>
          <button
            type="button"
            className={mode === "login" ? "auth-mode-pill active" : "auth-mode-pill"}
            onClick={() => setMode("login")}
          >
            {t("loginSignIn")}
          </button>
          <button
            type="button"
            className={mode === "register" ? "auth-mode-pill active" : "auth-mode-pill"}
            onClick={() => setMode("register")}
          >
            {t("loginCreate")}
          </button>
        </div>
      </div>

      <div className="social-login-grid auth-social-grid">
        <button type="button" className="social-button social-google" onClick={() => startSocialLogin("google")} disabled={socialLoading !== null}>
          <AppIcon name="google" className="social-icon" />
          <span>{socialLoading === "google" ? (isThai ? "??????????????..." : "Connecting...") : (isThai ? "???????????????? Google" : "Continue with Google")}</span>
        </button>
        <button type="button" className="social-button social-facebook" onClick={() => startSocialLogin("facebook")} disabled={socialLoading !== null}>
          <AppIcon name="facebook" className="social-icon" />
          <span>{socialLoading === "facebook" ? (isThai ? "??????????????..." : "Connecting...") : (isThai ? "???????????????? Facebook" : "Continue with Facebook")}</span>
        </button>
      </div>

      <div className="auth-divider">
        <span>{isThai ? "????????????" : "or use email"}</span>
      </div>

      {mode === "register" ? (
        <label className="label">
          {t("loginName")}
          <input className="input" name="name" placeholder={isThai ? "??????????" : "Your name"} required />
        </label>
      ) : null}

      <label className="label">
        {t("loginEmail")}
        <input className="input" name="email" type="email" placeholder="name@example.com" required />
      </label>

      <label className="label">
        {t("loginPassword")}
        <input className="input" name="password" type="password" minLength={6} required />
      </label>

      <button className="button auth-submit" disabled={loading} type="submit">
        {loading ? t("loginProcessing") : mode === "login" ? t("loginSubmit") : t("loginRegister")}
      </button>

      {message ? <p className="auth-feedback">{message}</p> : null}
    </form>
  );
}
