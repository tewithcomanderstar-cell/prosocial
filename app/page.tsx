"use client";

import Link from "next/link";
import { DashboardData } from "@/components/dashboard-data";
import { AppIcon } from "@/components/app-icon";
import { SectionCard } from "@/components/section-card";
import { SetupStatusPanel } from "@/components/setup-status-panel";
import { useI18n } from "@/components/language-provider";

export default function HomePage() {
  const { language, t } = useI18n();
  const isThai = language === "th";

  const categories = [
    {
      title: isThai ? "สร้างโพสต์" : "Create Post",
      href: "/posts/new",
      action: isThai ? "เปิด" : "Open",
      icon: "compose" as const,
      tooltip: isThai ? "สร้างโพสต์ทันทีหรือบันทึกเข้าโหมดอัตโนมัติ" : "Create, publish now, or save into auto mode"
    },
    {
      title: isThai ? "ปฏิทินโพสต์" : "Planner",
      href: "/planner",
      action: isThai ? "ดูคิว" : "View",
      icon: "planner" as const,
      tooltip: isThai ? "ดูและเลื่อนคิวโพสต์แบบภาพรวม" : "View and move scheduled posts visually"
    },
    {
      title: isThai ? "Analytics" : "Analytics",
      href: "/analytics",
      action: isThai ? "ดูผล" : "Open",
      icon: "analytics" as const,
      tooltip: isThai ? "ดูผลลัพธ์ของโพสต์และเวลาที่ได้ผลดี" : "Review performance and best posting times"
    },
    {
      title: isThai ? "ทีมและเวิร์กสเปซ" : "Team & Workspace",
      href: "/team",
      action: isThai ? "จัดการ" : "Manage",
      icon: "team" as const,
      tooltip: isThai ? "จัดการสิทธิ์ ทีม และ workspace" : "Manage team members, roles, and workspace"
    }
  ];

  return (
    <div className="stack page-stack">
      <div className="grid quick-grid">
        {categories.map((item) => (
          <Link key={item.href} href={item.href} className="card quick-card" title={item.tooltip}>
            <div className="quick-card-head">
              <AppIcon name={item.icon} className="quick-icon" />
              <h2>{item.title}</h2>
            </div>
            <span className="button-secondary quick-action">{item.action}</span>
          </Link>
        ))}
      </div>

      <DashboardData />

      <SectionCard
        title={t("homeSetupTitle")}
        icon="setup"
        tooltip={isThai ? "ดูว่าระบบพร้อมใช้งานจริงครบหรือยัง" : "Check which services are ready for production use"}
      >
        <SetupStatusPanel />
      </SectionCard>
    </div>
  );
}

