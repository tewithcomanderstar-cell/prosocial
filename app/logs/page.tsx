import { LogsDashboard } from "@/components/admin/logs-dashboard";
import { SectionCard } from "@/components/section-card";

export default function LogsPage() {
  return (
    <div className="stack">
      <SectionCard title="Operations">
        <LogsDashboard />
      </SectionCard>
    </div>
  );
}

