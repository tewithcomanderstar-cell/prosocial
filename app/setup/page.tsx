"use client";

import { SetupStatusPanel } from "@/components/setup-status-panel";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function SetupPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <SectionCard title={t("setupCardTitle")}>
        <SetupStatusPanel />
      </SectionCard>
    </div>
  );
}

