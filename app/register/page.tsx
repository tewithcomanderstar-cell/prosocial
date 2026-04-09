"use client";

import { Suspense } from "react";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";
import { useI18n } from "@/components/language-provider";

export default function RegisterPage() {
  const { language } = useI18n();
  const isThai = language === "th";

  return (
    <AuthShell
      eyebrow={isThai ? "สมัครสมาชิก" : "Create account"}
      title={isThai ? "เริ่มต้นเวิร์กสเปซของคุณในไม่กี่วินาที" : "Create your workspace in just a few moments"}
      subtitle={
        isThai
          ? "สร้างบัญชีเพื่อเริ่มเชื่อม Facebook, Google Drive และตั้งระบบโพสต์อัตโนมัติของคุณ"
          : "Create an account to connect Facebook, Google Drive, and set up your automated publishing system."
      }
    >
      <Suspense fallback={<div className="muted">Loading...</div>}>
        <LoginForm initialMode="register" />
      </Suspense>
    </AuthShell>
  );
}
