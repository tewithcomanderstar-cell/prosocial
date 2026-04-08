import { SectionCard } from "@/components/section-card";
import { BulkUploadPanel } from "@/components/product/bulk-upload-panel";

export default function BulkPage() {
  return (
    <div className="stack">
      <SectionCard title="Bulk Upload">
        <BulkUploadPanel />
      </SectionCard>
    </div>
  );
}

