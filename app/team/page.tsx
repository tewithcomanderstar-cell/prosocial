import { SectionCard } from "@/components/section-card";
import { TeamWorkspacePanel } from "@/components/product/team-workspace-panel";

export default function TeamPage() {
  return (
    <div className="stack">
      <SectionCard title="Workspace">
        <TeamWorkspacePanel />
      </SectionCard>
    </div>
  );
}

