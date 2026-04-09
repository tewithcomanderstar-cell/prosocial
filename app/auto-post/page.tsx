import { Suspense } from "react";
import { AutoPostPanel } from "@/components/auto-post-panel";
import { SectionCard } from "@/components/section-card";

export default function AutoPostPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Auto Post" icon="planner" tooltip="Google Drive + Facebook auto posting with interval, random delay, and logs">
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <AutoPostPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
