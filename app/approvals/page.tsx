import { ApprovalRequestsPanel } from "@/components/team/approval-requests-panel";
import { SectionCard } from "@/components/section-card";

export default function ApprovalsPage() {
  return (
    <div className="stack">
      <SectionCard title="Approvals" icon="team" tooltip="Reviewer inbox, status tracking, and approval turnaround.">
        <ApprovalRequestsPanel />
      </SectionCard>
    </div>
  );
}
