"use client";

import { Suspense } from "react";
import { GoogleDrivePanel } from "@/components/google-drive-panel";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function GoogleDriveConnectionPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <SectionCard title={t("driveCardTitle")}>
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <GoogleDrivePanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
