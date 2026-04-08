import { SectionCard } from "@/components/section-card";
import { PlannerBoard } from "@/components/planner/planner-board";

export default function PlannerPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Planner" icon="planner" tooltip="Move schedules and preview publishing slots">
        <PlannerBoard />
      </SectionCard>
    </div>
  );
}

