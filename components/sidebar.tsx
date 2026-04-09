"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppIcon, AppIconName } from "@/components/app-icon";
import { LanguageToggle } from "@/components/language-toggle";
import { useI18n } from "@/components/language-provider";

type NavItem = {
  href: string;
  label: string;
  icon: AppIconName;
};

type NavGroup = {
  title: string;
  icon: AppIconName;
  items: NavItem[];
};

export function Sidebar() {
  const pathname = usePathname();
  const { language, t } = useI18n();
  const isThai = language === "th";

  const groups: NavGroup[] = [
    {
      title: isThai ? "งานหลัก" : "Core",
      icon: "dashboard",
      items: [
        { href: "/dashboard", label: t("navDashboard"), icon: "dashboard" },
        { href: "/posts/new", label: isThai ? "สร้างโพสต์" : "Create Post", icon: "compose" },
        { href: "/planner", label: isThai ? "ปฏิทินโพสต์" : "Planner", icon: "planner" },
        { href: "/media-library", label: isThai ? "คลังคอนเทนต์" : "Media Library", icon: "media" }
      ]
    },
    {
      title: isThai ? "คอนเทนต์" : "Content",
      icon: "template",
      items: [
        { href: "/analytics", label: t("navAnalytics"), icon: "analytics" },
        { href: "/recommendations", label: isThai ? "คำแนะนำอัจฉริยะ" : "Recommendations", icon: "recommend" },
        { href: "/templates", label: isThai ? "เทมเพลตและแฮชแท็ก" : "Templates", icon: "template" },
        { href: "/bulk", label: isThai ? "อัปโหลดหลายโพสต์" : "Bulk Upload", icon: "bulk" }
      ]
    },
    {
      title: isThai ? "เวิร์กสเปซ" : "Workspace",
      icon: "team",
      items: [
        { href: "/profile", label: isThai ? "โปรไฟล์" : "Profile", icon: "profile" },
        { href: "/connected-accounts", label: isThai ? "บัญชีที่เชื่อมต่อ" : "Connected Accounts", icon: "accounts" },
        { href: "/team", label: isThai ? "ทีมและเวิร์กสเปซ" : "Team & Workspace", icon: "team" },
        { href: "/personas", label: t("navPersonas"), icon: "personas" },
        { href: "/connections/facebook", label: t("navFacebook"), icon: "facebook" },
        { href: "/connections/google-drive", label: t("navGoogle"), icon: "drive" }
      ]
    },
    {
      title: isThai ? "ระบบ" : "System",
      icon: "system",
      items: [
        { href: "/integrations", label: isThai ? "การเชื่อมต่อและแจ้งเตือน" : "Integrations & Notifications", icon: "integrations" },
        { href: "/settings", label: t("navSettings"), icon: "settings" },
        { href: "/logs", label: t("navLogs"), icon: "logs" },
        { href: "/setup", label: t("navSetup"), icon: "setup" },
        { href: "/privacy-policy", label: isThai ? "นโยบายความเป็นส่วนตัว" : "Privacy Policy", icon: "privacy" },
        { href: "/login", label: t("navLogin"), icon: "login" }
      ]
    }
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="kicker">{t("brandTag")}</div>
        <h1>{t("brandName")}</h1>
      </div>

      <div className="sidebar-card sidebar-language-card">
        <LanguageToggle />
      </div>

      <nav className="nav-groups">
        {groups.map((group) => (
          <section key={group.title} className="nav-group sidebar-card">
            <div className="nav-group-title">
              <AppIcon name={group.icon} className="nav-group-icon" />
              <span>{group.title}</span>
            </div>
            <div className="nav">
              {group.items.map((link) => (
                <Link key={link.href} href={link.href} className={pathname === link.href ? "active" : ""}>
                  <AppIcon name={link.icon} className="nav-link-icon" />
                  <span>{link.label}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </nav>
    </aside>
  );
}
