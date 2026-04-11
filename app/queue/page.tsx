import { QueuePanel } from "@/components/content/queue-panel";
import { SectionCard } from "@/components/section-card";

export default function QueuePage() {
  return (
    <div className="stack">
      <SectionCard title="Content Queue" icon="planner" tooltip="Drafts, reviews, approvals, retries, and scheduling in one operational queue.">
        <QueuePanel />
      </SectionCard>
    </div>
  );
}
