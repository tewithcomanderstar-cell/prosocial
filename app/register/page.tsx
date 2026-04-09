"use client";

import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

export default function RegisterPage() {
  const { language } = useI18n();
  const title = language === "th" ? "สมัครสมาชิก" : "Create account";

  return (
    <div className="stack">
      <SectionCard title={title}>
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <LoginForm initialMode="register" />
        </Suspense>
      </SectionCard>
    </div>
  );
}
