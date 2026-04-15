"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { dictionaries, Language, TranslationKey } from "@/lib/i18n";

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const language: Language = "th";

  useEffect(() => {
    window.localStorage.setItem("ui-language", "th");
    document.documentElement.lang = "th";
  }, []);

  function setLanguage(_: Language) {
    window.localStorage.setItem("ui-language", "th");
    document.documentElement.lang = "th";
  }

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (key: TranslationKey) => dictionaries[language][key]
    }),
    [language]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n() {
  const context = useContext(LanguageContext);

  if (!context) {
    throw new Error("useI18n must be used within LanguageProvider");
  }

  return context;
}
