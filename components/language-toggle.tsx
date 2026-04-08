"use client";

import { useI18n } from "@/components/language-provider";

export function LanguageToggle() {
  const { language, setLanguage, t } = useI18n();

  return (
    <div className="language-box">
      <div className="language-label">{t("langLabel")}</div>
      <div className="language-toggle">
        <button
          type="button"
          className={language === "en" ? "lang-btn active" : "lang-btn"}
          onClick={() => setLanguage("en")}
        >
          {t("langEn")}
        </button>
        <button
          type="button"
          className={language === "th" ? "lang-btn active" : "lang-btn"}
          onClick={() => setLanguage("th")}
        >
          {t("langTh")}
        </button>
      </div>
    </div>
  );
}
