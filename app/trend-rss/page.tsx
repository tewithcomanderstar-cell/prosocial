import { Suspense } from "react";
import { SectionCard } from "@/components/section-card";
import { TrendRssPanel } from "@/components/trend-rss-panel";

export default function TrendRssPage() {
  return (
    <div className="stack page-stack">
      <SectionCard
        title="โหมดจับกระแสข่าว"
        icon="planner"
        tooltip="จับกระแสจาก Page ID ข่าวต้นทาง ไปหาเว็บข่าวที่เลือกเพื่อสรุปใหม่ แล้วส่งต่อเข้า draft หรือโพสต์อัตโนมัติ"
      >
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <TrendRssPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
