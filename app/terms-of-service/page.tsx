import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service | Prosocial System",
  description: "Terms of Service for Prosocial System."
};

export default function TermsOfServicePage() {
  return (
    <div className="stack">
      <section className="card stack" style={{ gap: 20 }}>
        <div className="stack" style={{ gap: 8 }}>
          <p className="eyebrow">Legal</p>
          <h1>Terms of Service</h1>
          <p className="muted">
            These terms govern your use of Prosocial System and its automation, publishing, and account
            connection features.
          </p>
        </div>

        <section className="stack" style={{ gap: 8 }}>
          <h2>1. Acceptable use</h2>
          <p>
            You may use the service only for lawful publishing and operational workflows. You are responsible
            for the content you upload, generate, schedule, approve, and publish through the platform.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>2. Connected accounts</h2>
          <p>
            By connecting Facebook or Google services, you confirm that you have the necessary rights to access
            those assets and authorize the app to act on your behalf within the granted scopes.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>3. Service availability</h2>
          <p>
            We aim to keep the platform available and reliable, but automation, provider APIs, and scheduled
            jobs can fail. You should review approval, audit, and publishing outcomes before relying on them for
            critical campaigns.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>4. Suspension and termination</h2>
          <p>
            Access may be restricted or removed if the platform is used in ways that violate provider policies,
            platform rules, or applicable law, or that create operational or security risk.
          </p>
        </section>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/privacy-policy">Privacy Policy</Link>
          <Link href="/data-deletion">Data Deletion</Link>
          <Link href="/login">Back to Login</Link>
        </div>
      </section>
    </div>
  );
}
