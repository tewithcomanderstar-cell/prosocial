import { SVGProps } from "react";

export type AppIconName =
  | "dashboard"
  | "compose"
  | "planner"
  | "media"
  | "analytics"
  | "recommend"
  | "template"
  | "bulk"
  | "team"
  | "personas"
  | "facebook"
  | "google"
  | "drive"
  | "integrations"
  | "settings"
  | "logs"
  | "setup"
  | "login"
  | "privacy"
  | "profile"
  | "accounts"
  | "system";

type AppIconProps = SVGProps<SVGSVGElement> & {
  name: AppIconName;
};

export function AppIcon({ name, className, ...props }: AppIconProps) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: className ?? "app-icon",
    ...props
  };

  switch (name) {
    case "dashboard":
      return <svg {...common}><path d="M4 5h7v6H4z" /><path d="M13 5h7v10h-7z" /><path d="M4 13h7v6H4z" /><path d="M13 17h7v2h-7z" /></svg>;
    case "compose":
      return <svg {...common}><path d="M4 20h4l10-10-4-4L4 16v4z" /><path d="M13 7l4 4" /></svg>;
    case "planner":
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4" /><path d="M16 3v4" /><path d="M3 10h18" /></svg>;
    case "media":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m8 13 2.5-2.5L16 16" /><circle cx="9" cy="9" r="1.2" /></svg>;
    case "analytics":
      return <svg {...common}><path d="M5 19V9" /><path d="M12 19V5" /><path d="M19 19v-7" /></svg>;
    case "recommend":
      return <svg {...common}><path d="M12 3l2.8 5.7L21 9.6l-4.5 4.4 1.1 6.1L12 17l-5.6 3.1 1.1-6.1L3 9.6l6.2-.9L12 3z" /></svg>;
    case "template":
      return <svg {...common}><path d="M6 4h12v16H6z" /><path d="M9 8h6" /><path d="M9 12h6" /><path d="M9 16h4" /></svg>;
    case "bulk":
      return <svg {...common}><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h10" /><path d="M18 15v4" /><path d="M16 17h4" /></svg>;
    case "team":
      return <svg {...common}><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M4 19c.7-3 3-4.5 5-4.5s4.3 1.5 5 4.5" /><path d="M14.5 18c.4-1.8 1.8-3 3.5-3 1.4 0 2.6.7 3.2 2" /></svg>;
    case "personas":
      return <svg {...common}><path d="M12 21c4-2.2 6-5.2 6-9V5l-6-2-6 2v7c0 3.8 2 6.8 6 9z" /><path d="M9.5 12.5c.7.7 1.3 1 2.5 1s1.8-.3 2.5-1" /><circle cx="9.5" cy="9.5" r=".5" fill="currentColor" stroke="none" /><circle cx="14.5" cy="9.5" r=".5" fill="currentColor" stroke="none" /></svg>;
    case "facebook":
      return (
        <svg viewBox="0 0 24 24" className={className ?? "app-icon"} aria-hidden="true" {...props}>
          <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.02 4.39 11 10.13 11.93v-8.43H7.08v-3.5h3.05V9.41c0-3.03 1.79-4.7 4.53-4.7 1.31 0 2.69.24 2.69.24v2.97h-1.52c-1.5 0-1.96.94-1.96 1.9v2.28h3.34l-.53 3.5h-2.81V24C19.61 23.07 24 18.09 24 12.07z"/>
          <path fill="#fff" d="M16.68 15.57l.53-3.5h-3.34V9.79c0-.96.46-1.9 1.96-1.9h1.52V4.92s-1.38-.24-2.69-.24c-2.74 0-4.53 1.68-4.53 4.7v2.69H7.08v3.5h3.05V24a12.2 12.2 0 0 0 3.74 0v-8.43h2.81z"/>
        </svg>
      );
    case "google":
      return (
        <svg viewBox="0 0 24 24" className={className ?? "app-icon"} aria-hidden="true" {...props}>
          <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v2.99h3.88c2.28-2.1 3.56-5.2 3.56-8.63z"/>
          <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-2.99c-1.08.73-2.46 1.16-4.07 1.16-3.12 0-5.76-2.11-6.7-4.95H1.3v3.08A12 12 0 0 0 12 24z"/>
          <path fill="#FBBC05" d="M5.3 14.31A7.2 7.2 0 0 1 4.93 12c0-.8.14-1.58.37-2.31V6.61H1.3A12 12 0 0 0 0 12c0 1.93.46 3.75 1.3 5.39l4-3.08z"/>
          <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.58 1.81l3.43-3.43C17.95 1.2 15.23 0 12 0A12 12 0 0 0 1.3 6.61l4 3.08c.94-2.84 3.58-4.92 6.7-4.92z"/>
        </svg>
      );
    case "drive":
      return <svg {...common}><path d="M9 4h6l6 10H15z" /><path d="M9 4 3 14h6l6-10" /><path d="M3 14h12l-3 6H6z" /></svg>;
    case "integrations":
      return <svg {...common}><path d="M8 8h4V4" /><path d="M16 16h-4v4" /><path d="M8 16H4v-4" /><path d="M16 8h4v4" /><path d="M8 8 4 12l4 4" /><path d="M16 8l4 4-4 4" /></svg>;
    case "settings":
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c0 .7.4 1.3 1 1.5h.2a2 2 0 1 1 0 4H20c-.7 0-1.3.4-1.5 1z" /></svg>;
    case "logs":
      return <svg {...common}><path d="M8 6h11" /><path d="M8 12h11" /><path d="M8 18h11" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></svg>;
    case "setup":
      return <svg {...common}><path d="M12 3 4 7v5c0 5 3.4 7.8 8 9 4.6-1.2 8-4 8-9V7l-8-4z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "login":
      return <svg {...common}><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path d="M21 21V3" /></svg>;
    case "privacy":
      return <svg {...common}><path d="M12 21c4-2.2 7-5.3 7-9.5V5.5L12 3 5 5.5v6C5 15.7 8 18.8 12 21z" /><path d="M9.5 11.5V10a2.5 2.5 0 0 1 5 0v1.5" /><rect x="8.5" y="11.5" width="7" height="5" rx="1.5" /></svg>;
    case "profile":
      return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>;
    case "accounts":
      return <svg {...common}><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M21 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13A4 4 0 0 1 16 10.87" /></svg>;
    case "system":
      return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8 9h8" /><path d="M8 13h5" /></svg>;
  }
}
