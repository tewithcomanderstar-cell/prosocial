import { SectionCard } from "@/components/section-card";
import { IntegrationsNotificationsPanel } from "@/components/product/integrations-notifications-panel";

export default function IntegrationsPage() {
  return (
    <div className="stack">
      <SectionCard title="Connections">
        <IntegrationsNotificationsPanel />
      </SectionCard>
    </div>
  );
}

