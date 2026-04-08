"use client";

import { FacebookConnectionPanel } from "@/components/facebook-connection-panel";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function FacebookConnectionPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <SectionCard title={t("facebookCardTitle")}>
        <FacebookConnectionPanel />
      </SectionCard>
    </div>
  );
}

