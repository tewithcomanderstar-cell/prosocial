"use client";

import { SetupStatusPanel } from "@/components/setup-status-panel";
import { SetupWizard } from "@/components/setup-wizard";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function SetupPage() {
  const { t } = useI18n();

  return (
    <div className="stack page-stack">
      <SectionCard title="Setup Wizard" tooltip="Guide the workspace from first connection to live automation.">
        <SetupWizard />
      </SectionCard>

      <SectionCard title={t("setupCardTitle")}>
        <SetupStatusPanel />
      </SectionCard>
    </div>
  );
}
