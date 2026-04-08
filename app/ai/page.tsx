"use client";

import { AiGeneratorForm } from "@/components/ai-generator-form";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function AiPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <SectionCard title={t("aiCardTitle")}>
        <AiGeneratorForm />
      </SectionCard>
    </div>
  );
}

