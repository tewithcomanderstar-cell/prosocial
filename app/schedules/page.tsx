"use client";

import { ScheduleForm } from "@/components/schedule-form";
import { ScheduleTable } from "@/components/schedule-table";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function SchedulesPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <div className="grid cols-2">
        <SectionCard title={t("scheduleCreateTitle")}>
          <ScheduleForm />
        </SectionCard>

        <SectionCard title={t("scheduleListTitle")}>
          <ScheduleTable />
        </SectionCard>
      </div>
    </div>
  );
}

