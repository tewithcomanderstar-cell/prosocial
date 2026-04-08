"use client";

import { GoogleDrivePanel } from "@/components/google-drive-panel";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function GoogleDriveConnectionPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <SectionCard title={t("driveCardTitle")}>
        <GoogleDrivePanel />
      </SectionCard>
    </div>
  );
}

