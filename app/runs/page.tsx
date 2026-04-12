import { RunsPanel } from "@/components/operations/runs-panel";
import { SectionCard } from "@/components/section-card";

export default function RunsPage() {
  return (
    <div className="stack">
      <SectionCard title="Workflow Runs" icon="logs" tooltip="Execution history, retry handling, and run health.">
        <RunsPanel />
      </SectionCard>
    </div>
  );
}
