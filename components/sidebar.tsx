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
  const { t } = useI18n();

  const groups: NavGroup[] = [
    {
      title: "Overview",
      icon: "dashboard",
      items: [
        { href: "/dashboard", label: t("navDashboard"), icon: "dashboard" },
        { href: "/runs", label: "Runs", icon: "logs" },
        { href: "/notifications", label: "Alerts", icon: "integrations" },
        { href: "/incidents", label: "Error Center", icon: "logs" }
      ]
    },
    {
      title: "Automation",
      icon: "planner",
      items: [
        { href: "/auto-post", label: "Workflows", icon: "planner" },
        { href: "/templates", label: "Templates", icon: "template" }
      ]
    },
    {
      title: "Content",
      icon: "compose",
      items: [
        { href: "/posts/new", label: "Create Post", icon: "compose" },
        { href: "/queue", label: "Queue", icon: "bulk" },
        { href: "/planner", label: "Planner", icon: "planner" },
        { href: "/media-library", label: "Media Library", icon: "media" },
        { href: "/ai", label: "AI Tools", icon: "recommend" }
      ]
    },
    {
      title: "Facebook",
      icon: "facebook",
      items: [
        { href: "/connected-accounts", label: "Pages", icon: "accounts" },
        { href: "/connections/facebook", label: t("navFacebook"), icon: "facebook" },
        { href: "/connections/google-drive", label: t("navGoogle"), icon: "drive" }
      ]
    },
    {
      title: "Team",
      icon: "team",
      items: [
        { href: "/approvals", label: "Approvals", icon: "team" },
        { href: "/team", label: "Members & Roles", icon: "team" },
        { href: "/personas", label: t("navPersonas"), icon: "personas" }
      ]
    },
    {
      title: "System",
      icon: "system",
      items: [
        { href: "/integrations", label: "API / Webhooks", icon: "integrations" },
        { href: "/analytics", label: t("navAnalytics"), icon: "analytics" },
        { href: "/settings", label: t("navSettings"), icon: "settings" },
        { href: "/logs", label: t("navLogs"), icon: "logs" },
        { href: "/setup", label: t("navSetup"), icon: "setup" },
        { href: "/profile", label: "Profile", icon: "profile" },
        { href: "/login", label: "Login", icon: "login" },
        { href: "/privacy-policy", label: "Privacy Policy", icon: "privacy" }
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
