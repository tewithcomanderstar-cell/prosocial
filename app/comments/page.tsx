import { Suspense } from "react";
import { CommentAutomationPanel } from "@/components/operations/comment-automation-panel";
import { SectionCard } from "@/components/section-card";

export default function CommentsPage() {
  return (
    <div className="stack page-stack">
      <SectionCard
        title="Auto Comment"
        icon="compose"
        tooltip="ระบบตอบคอมเมนต์อัตโนมัติใต้โพสต์ Facebook ตามคีย์เวิร์ดที่ตั้งไว้"
      >
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <CommentAutomationPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
