"use client";

import { ReactNode } from "react";
import { useI18n } from "@/components/language-provider";

type AuthShellProps = {
  title: string;
  subtitle: string;
  eyebrow: string;
  children: ReactNode;
};

export function AuthShell({ title, subtitle, eyebrow, children }: AuthShellProps) {
  const { language } = useI18n();
  const isThai = language === "th";

  const highlights = isThai
    ? [
        "เชื่อม Facebook และ Google ได้ในหน้าเดียว",
        "จัดการโพสต์ ตารางเวลา และคิวงานแบบรวมศูนย์",
        "พร้อมต่อยอดเป็น SaaS สำหรับหลายผู้ใช้"
      ]
    : [
        "Connect Facebook and Google from one place",
        "Manage posts, schedules, and queues centrally",
        "Ready to grow into a multi-user SaaS workflow"
      ];

  return (
    <div className="auth-shell">
      <section className="auth-hero-card">
        <div className="auth-kicker">{eyebrow}</div>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-copy">{subtitle}</p>
        <div className="auth-highlight-grid">
          {highlights.map((item) => (
            <div key={item} className="auth-highlight-pill">
              <span className="auth-highlight-dot" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="auth-form-card">{children}</section>
    </div>
  );
}
