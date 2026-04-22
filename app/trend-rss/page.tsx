import { Suspense } from "react";
import { SectionCard } from "@/components/section-card";
import { TrendRssPanel } from "@/components/trend-rss-panel";

export default function TrendRssPage() {
  return (
    <div className="stack page-stack">
      <SectionCard
        title="โหมดโพสต์ข่าว RSS"
        icon="planner"
        tooltip="จับกระแสจากเพจที่ติดตาม จับคู่ RSS และสร้าง draft ข่าวเข้า pipeline เดิมของระบบ"
      >
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <TrendRssPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
