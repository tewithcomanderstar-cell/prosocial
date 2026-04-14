import { CommentAutomationPanel } from "@/components/operations/comment-automation-panel";
import { SectionCard } from "@/components/section-card";

export default function CommentsPage() {
  return (
    <div className="stack page-stack">
      <SectionCard
        title="Auto Comment"
        icon="integrations"
        tooltip="Manage Facebook comment ingestion, reply rules, and the inbox that tracks automatic replies."
      >
        <CommentAutomationPanel />
      </SectionCard>
    </div>
  );
}
