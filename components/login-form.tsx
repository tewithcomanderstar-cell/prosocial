"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppIcon } from "@/components/app-icon";
import { useI18n } from "@/components/language-provider";

export function LoginForm() {
  const router = useRouter();
  const { language, t } = useI18n();
  const isThai = language === "th";
  const [mode, setMode] = useState<"login" | "register">("login");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setMessage(params.get("error") || "");
  }, []);

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

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="social-login-grid">
        <Link href="/api/auth/google/start" className="social-button social-google">
          <AppIcon name="google" className="social-icon" />
          <span>{isThai ? "ดำเนินการต่อด้วย Google" : "Continue with Google"}</span>
        </Link>
        <Link href="/api/auth/facebook/start" className="social-button social-facebook">
          <AppIcon name="facebook" className="social-icon" />
          <span>{isThai ? "ดำเนินการต่อด้วย Facebook" : "Continue with Facebook"}</span>
        </Link>
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
