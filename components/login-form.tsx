"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppIcon } from "@/components/app-icon";
import { useI18n } from "@/components/language-provider";

function mapAuthMessage(code: string, isThai: boolean) {
  const messages: Record<string, string> = {
    missing_google_oauth: isThai ? "ระบบ Google Login ยังตั้งค่าไม่ครบใน environment variables" : "Google Login is not configured yet.",
    missing_facebook_oauth: isThai ? "ระบบ Facebook Login ยังตั้งค่าไม่ครบใน environment variables" : "Facebook Login is not configured yet.",
    invalid_google_state: isThai ? "สถานะการยืนยันตัวตนของ Google ไม่ถูกต้อง กรุณาลองใหม่" : "Invalid Google OAuth state. Please try again.",
    invalid_facebook_state: isThai ? "สถานะการยืนยันตัวตนของ Facebook ไม่ถูกต้อง กรุณาลองใหม่" : "Invalid Facebook OAuth state. Please try again.",
    google_token_exchange_failed: isThai ? "Google แลก token ไม่สำเร็จ กรุณาลอง login ใหม่" : "Google token exchange failed. Please try again.",
    facebook_token_exchange_failed: isThai ? "Facebook แลก token ไม่สำเร็จ กรุณาลอง login ใหม่" : "Facebook token exchange failed. Please try again.",
    google_profile_failed: isThai ? "ไม่สามารถดึงข้อมูลโปรไฟล์ Google ได้" : "Unable to load Google profile.",
    facebook_profile_failed: isThai ? "ไม่สามารถดึงข้อมูลโปรไฟล์ Facebook ได้" : "Unable to load Facebook profile.",
    google_login_failed: isThai ? "Google Login ล้มเหลว กรุณาลองใหม่" : "Google login failed. Please try again.",
    facebook_login_failed: isThai ? "Facebook Login ล้มเหลว กรุณาลองใหม่" : "Facebook login failed. Please try again.",
    unsupported_permission: isThai ? "แอป Facebook ยังไม่ได้รับสิทธิ์ที่จำเป็น กรุณาตรวจสอบ Login Configuration และ App Review" : "The Facebook app is missing required permissions. Review Login Configuration and app permissions."
  };

  return messages[code] || code;
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { language, t } = useI18n();
  const isThai = language === "th";
  const [mode, setMode] = useState<"login" | "register">("login");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<"google" | "facebook" | null>(null);

  const mappedError = useMemo(() => {
    const error = searchParams.get("error") || "";
    return error ? mapAuthMessage(error, isThai) : "";
  }, [searchParams, isThai]);

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
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    setLoading(false);
    setMessage(result.message || (result.ok ? t("commonSuccess") : t("commonRequestFailed")));

    if (result.ok) {
      router.push("/");
      router.refresh();
    }
  }

  function startSocialLogin(provider: "google" | "facebook") {
    setSocialLoading(provider);
    window.location.href = `/api/auth/${provider}/start`;
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="social-login-grid">
        <button type="button" className="social-button social-google" onClick={() => startSocialLogin("google")} disabled={socialLoading !== null}>
          <AppIcon name="google" className="social-icon" />
          <span>{socialLoading === "google" ? (isThai ? "กำลังเชื่อมต่อ..." : "Connecting...") : (isThai ? "ดำเนินการต่อด้วย Google" : "Continue with Google")}</span>
        </button>
        <button type="button" className="social-button social-facebook" onClick={() => startSocialLogin("facebook")} disabled={socialLoading !== null}>
          <AppIcon name="facebook" className="social-icon" />
          <span>{socialLoading === "facebook" ? (isThai ? "กำลังเชื่อมต่อ..." : "Connecting...") : (isThai ? "ดำเนินการต่อด้วย Facebook" : "Continue with Facebook")}</span>
        </button>
      </div>

      <div className="auth-divider">
        <span>{isThai ? "หรือ" : "or"}</span>
      </div>

      <div className="split auth-mode-row">
        <h2>{mode === "login" ? t("loginSignIn") : t("loginCreate")}</h2>
        <button
          type="button"
          className="button-secondary"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? t("loginCreate") : t("loginBack")}
        </button>
      </div>

      {mode === "register" ? (
        <label className="label">
          {t("loginName")}
          <input className="input" name="name" placeholder={isThai ? "ชื่อของคุณ" : "Your name"} required />
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

      <button className="button" disabled={loading} type="submit">
        {loading ? t("loginProcessing") : mode === "login" ? t("loginSubmit") : t("loginRegister")}
      </button>

      {message ? <p className="muted">{message}</p> : null}
    </form>
  );
}
