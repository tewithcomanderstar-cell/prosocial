"use client";

import { FormEvent, useState } from "react";
import { useI18n } from "@/components/language-provider";

type Variant = {
  caption: string;
  hashtags: string[];
};

export function AiGeneratorForm() {
  const { t } = useI18n();
  const [variants, setVariants] = useState<Variant[]>([]);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const keyword = String(formData.get("keyword") || "");

    const response = await fetch("/api/ai/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ keyword })
    });

    const result = await response.json();
    setLoading(false);
    if (result.ok) {
      setVariants(result.data.variants);
    }
  }

  return (
    <div className="stack">
      <form className="form" onSubmit={handleSubmit}>
        <label className="label">
          {t("aiKeyword")}
          <input className="input" name="keyword" placeholder={t("aiKeywordPlaceholder")} required />
        </label>
        <button className="button" disabled={loading} type="submit">
          {loading ? t("aiGenerating") : t("aiGenerate")}
        </button>
      </form>

      <div className="variants">
        {variants.map((variant, index) => (
          <article key={index} className="variant">
            <strong>Option {index + 1}</strong>
            <p>{variant.caption}</p>
            <p className="muted">{variant.hashtags.join(" ")}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
