import { AdvancedSettingsForm } from "@/components/admin/advanced-settings-form";
import { SectionCard } from "@/components/section-card";
import { SystemOpsPanel } from "@/components/admin/system-ops-panel";

export default function SettingsPage() {
  return (
    <div className="stack page-stack">
      <SectionCard title="Posting Settings" icon="settings" tooltip="Limits, delays, randomization, and posting controls">
        <AdvancedSettingsForm />
      </SectionCard>

      <SectionCard title="System" icon="system" tooltip="Token status, export, and recovery tools">
        <SystemOpsPanel />
      </SectionCard>
    </div>
  );
}

