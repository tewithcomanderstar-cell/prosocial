import type { Metadata } from "next";
import { Noto_Sans_Thai, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { LanguageProvider } from "@/components/language-provider";

const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"]
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-english",
  weight: ["500", "600", "700", "800"]
});

export const metadata: Metadata = {
  title: "Prosocial System",
  description: "Facebook auto posting system with AI content, multi-page management and Google Drive images."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${notoSansThai.variable} ${plusJakartaSans.variable}`}>
        <LanguageProvider>
          <div className="desktop-bg">
            <div className="desktop-orb orb-a" />
            <div className="desktop-orb orb-b" />
            <div className="desktop-orb orb-c" />
            <div className="shell">
              <div className="window-chrome">
                <span className="traffic red" />
                <span className="traffic yellow" />
                <span className="traffic green" />
                <div className="window-title">Prosocial System</div>
              </div>
              <Sidebar />
              <main className="content">{children}</main>
            </div>
          </div>
        </LanguageProvider>
      </body>
    </html>
  );
}
