import { Suspense } from "react";
import { AutoPostPanel } from "@/components/auto-post-panel";
import { SectionCard } from "@/components/section-card";

export default function AutoPostAiPage() {
  return (
    <div className="stack page-stack">
      <SectionCard
        title="โหมดหลายภาพ AI"
        icon="planner"
        tooltip="ระบบโพสต์อัตโนมัติแบบหลายภาพ พร้อมแคปชั่น AI จากรายละเอียดของภาพ"
      >
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <AutoPostPanel forcedAutomationMode="multi-image-ai" hideAutomationModeSelector />
        </Suspense>
      </SectionCard>
    </div>
  );
}
