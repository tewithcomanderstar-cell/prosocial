"use client";

import Link from "next/link";
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

  const highlights = [
    isThai ? "Connect Facebook and Google in one place" : "Connect Facebook and Google from one place",
    isThai ? "Manage posts, schedules, and queues centrally" : "Manage posts, schedules, and queues centrally",
    isThai ? "Ready to grow into a multi-user SaaS workflow" : "Ready to grow into a multi-user SaaS workflow"
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

      <section className="auth-form-card stack" style={{ gap: 16 }}>
        {children}
        <div className="muted" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/privacy-policy">{isThai ? "Privacy Policy" : "Privacy Policy"}</Link>
          <Link href="/terms-of-service">{isThai ? "Terms of Service" : "Terms of Service"}</Link>
          <Link href="/data-deletion">{isThai ? "Data Deletion" : "Data Deletion"}</Link>
        </div>
      </section>
    </div>
  );
}
