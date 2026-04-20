import { Suspense } from "react";
import { AutoPostAiPanel } from "@/components/auto-post-ai-panel";
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
          <AutoPostAiPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
