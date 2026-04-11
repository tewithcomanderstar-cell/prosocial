import { RunDetailPanel } from "@/components/operations/run-detail-panel";
import { SectionCard } from "@/components/section-card";

type RunDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { id } = await params;

  return (
    <div className="stack">
      <SectionCard title="Run Detail" icon="logs" tooltip="Inspect step-by-step execution state, diagnostics, and recovery context.">
        <RunDetailPanel runId={id} />
      </SectionCard>
    </div>
  );
}
