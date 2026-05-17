import { Suspense } from "react";
import { AutoPostPanel } from "@/components/auto-post-panel";
import { SectionCard } from "@/components/section-card";

export default function AutoPostPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Shopee Affiliate Auto Post" icon="planner" tooltip="In-app automation engine for Shopee affiliate products, Facebook pages, and live status">
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <AutoPostPanel />
        </Suspense>
      </SectionCard>
    </div>
  );
}
