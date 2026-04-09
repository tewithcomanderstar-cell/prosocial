import { Suspense } from "react";
import { AutoPostPanel } from "@/components/auto-post-panel";
import { SectionCard } from "@/components/section-card";

export default function AutoPostPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Auto Post" icon="planner" tooltip="n8n control panel for Drive folders, Facebook pages, and live status">
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <AutoPostPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
