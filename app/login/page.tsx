"use client";

import { Suspense } from "react";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";
import { useI18n } from "@/components/language-provider";

export default function LoginPage() {
  const { language } = useI18n();
  const isThai = language === "th";

  return (
    <AuthShell
      eyebrow={isThai ? "เข้าสู่ระบบ" : "Sign in"}
      title={isThai ? "เข้าถึงระบบจัดการโพสต์อย่างเป็นระบบ" : "Access your publishing workspace with confidence"}
      subtitle={
        isThai
          ? "เข้าสู่ระบบเพื่อจัดการเพจ คิวโพสต์ AI และการเชื่อมต่อทั้งหมดจากพื้นที่ทำงานเดียว"
          : "Sign in to manage pages, publishing queues, AI content, and connected accounts from one workspace."
      }
    >
      <Suspense fallback={<div className="muted">Loading...</div>}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
