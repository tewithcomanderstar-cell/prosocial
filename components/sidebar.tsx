"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppIcon, AppIconName } from "@/components/app-icon";
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
      title: t("groupOverview"),
      icon: "dashboard",
      items: [
        { href: "/dashboard", label: t("navDashboard"), icon: "dashboard" },
        { href: "/runs", label: t("navRuns"), icon: "logs" },
        { href: "/notifications", label: t("navAlerts"), icon: "integrations" },
        { href: "/incidents", label: t("navErrorCenter"), icon: "logs" }
      ]
    },
    {
      title: t("groupAutomation"),
      icon: "planner",
      items: [
        { href: "/auto-post", label: t("navWorkflows"), icon: "planner" },
        { href: "/templates", label: t("navTemplates"), icon: "template" }
      ]
    },
    {
      title: t("groupContent"),
      icon: "compose",
      items: [
        { href: "/posts/new", label: t("navCompose"), icon: "compose" },
        { href: "/queue", label: t("navQueue"), icon: "bulk" },
        { href: "/planner", label: t("navPlanner"), icon: "planner" },
        { href: "/media-library", label: t("navMediaLibrary"), icon: "media" },
        { href: "/ai", label: t("navAiTools"), icon: "recommend" }
      ]
    },
    {
      title: t("groupFacebook"),
      icon: "facebook",
      items: [
        { href: "/connected-accounts", label: t("navPages"), icon: "accounts" },
        { href: "/comments", label: t("navAutoComments"), icon: "integrations" },
        { href: "/connections/facebook", label: t("navFacebook"), icon: "facebook" },
        { href: "/connections/google-drive", label: t("navGoogle"), icon: "drive" }
      ]
    },
    {
      title: t("groupTeam"),
      icon: "team",
      items: [
        { href: "/approvals", label: t("navApprovals"), icon: "team" },
        { href: "/team", label: t("navMembersRoles"), icon: "team" },
        { href: "/personas", label: t("navPersonas"), icon: "personas" }
      ]
    },
    {
      title: t("groupSystem"),
      icon: "system",
      items: [
        { href: "/integrations", label: t("navApiWebhooks"), icon: "integrations" },
        { href: "/analytics", label: t("navAnalytics"), icon: "analytics" },
        { href: "/settings", label: t("navSettings"), icon: "settings" },
        { href: "/logs", label: t("navLogs"), icon: "logs" },
        { href: "/setup", label: t("navSetup"), icon: "setup" },
        { href: "/profile", label: t("navProfile"), icon: "profile" },
        { href: "/login", label: t("navLogin"), icon: "login" },
        { href: "/privacy-policy", label: t("navPrivacy"), icon: "privacy" }
      ]
    }
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Image
            src="/branding/prosocial-logo.png"
            alt="Prosocial logo"
            width={52}
            height={52}
            className="brand-logo"
            priority
          />
          <div className="brand-copy">
            <div className="kicker">{t("brandTag")}</div>
            <h1>{t("brandName")}</h1>
          </div>
        </div>
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
