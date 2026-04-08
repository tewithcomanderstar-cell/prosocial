"use client";

import { PostComposerForm } from "@/components/post-composer-form";
import { ScheduleTable } from "@/components/schedule-table";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function NewPostPage() {
  const { language } = useI18n();
  const isThai = language === "th";

  return (
    <div className="stack">
      <PostComposerForm />

      <SectionCard title={isThai ? "คิวโพสต์ล่าสุด" : "Recent queue"}>
        <ScheduleTable />
      </SectionCard>
    </div>
  );
}
