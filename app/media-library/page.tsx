import { SectionCard } from "@/components/section-card";
import { MediaLibraryPanel } from "@/components/media/media-library-panel";

export default function MediaLibraryPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Library" icon="media" tooltip="Browse reusable content, assets, and posting history">
        <MediaLibraryPanel />
      </SectionCard>
    </div>
  );
}

