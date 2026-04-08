"use client";

import { LoginForm } from "@/components/login-form";
import { LogoutButton } from "@/components/logout-button";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function LoginPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <SectionCard title={t("loginCardTitle")} action={<LogoutButton />}>
        <LoginForm />
      </SectionCard>
    </div>
  );
}

