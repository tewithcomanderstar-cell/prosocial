import { SectionCard } from "@/components/section-card";
import { IntegrationsNotificationsPanel } from "@/components/product/integrations-notifications-panel";

export default function NotificationsPage() {
  return (
    <div className="stack">
      <SectionCard title="Channels">
        <IntegrationsNotificationsPanel />
      </SectionCard>
    </div>
  );
}

