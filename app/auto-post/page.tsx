import { Suspense } from "react";
import { AutoPostPanel } from "@/components/auto-post-panel";
import { SectionCard } from "@/components/section-card";

export default function AutoPostPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Auto Post" icon="planner" tooltip="Control panel for n8n-driven Google Drive and Facebook automation">
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <AutoPostPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
