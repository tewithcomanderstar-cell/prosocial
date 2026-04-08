import { PersonaManager } from "@/components/admin/persona-manager";
import { SectionCard } from "@/components/section-card";

export default function PersonasPage() {
  return (
    <div className="stack">
      <SectionCard title="Persona Profiles">
        <PersonaManager />
      </SectionCard>
    </div>
  );
}

