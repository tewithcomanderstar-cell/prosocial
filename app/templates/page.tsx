import { SectionCard } from "@/components/section-card";
import { TemplateHashtagManager } from "@/components/product/template-hashtag-manager";

export default function TemplatesPage() {
  return (
    <div className="stack">
      <SectionCard title="Templates & Hashtags">
        <TemplateHashtagManager />
      </SectionCard>
    </div>
  );
}

