"use client";

import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { LogoutButton } from "@/components/logout-button";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function LoginPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <SectionCard title={t("loginCardTitle")} action={<LogoutButton />}>
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <LoginForm />
        </Suspense>
      </SectionCard>
    </div>
  );
}
