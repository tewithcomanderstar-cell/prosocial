import { SectionCard } from "@/components/section-card";
import { AnalyticsDashboard } from "@/components/admin/analytics-dashboard";

export default function AnalyticsPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Performance" icon="analytics" tooltip="Performance metrics, best post, and recent snapshots">
        <AnalyticsDashboard />
      </SectionCard>
    </div>
  );
}

