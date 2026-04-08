import { SectionCard } from "@/components/section-card";
import { RecommendationPanel } from "@/components/product/recommendation-panel";

export default function RecommendationsPage() {
  return (
    <div className="stack">
      <SectionCard title="AI">
        <RecommendationPanel />
      </SectionCard>
    </div>
  );
}

