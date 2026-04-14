import { IncidentCenter } from "@/components/incident-center";
import { SectionCard } from "@/components/section-card";

export default function IncidentsPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Error Center" icon="logs" tooltip="Grouped issues, root causes, and one-click fixes for automation problems.">
        <IncidentCenter />
      </SectionCard>
    </div>
  );
}
