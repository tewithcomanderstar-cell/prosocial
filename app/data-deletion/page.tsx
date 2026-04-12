import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data Deletion | Prosocial System",
  description: "Data deletion instructions for Prosocial System and connected Facebook or Google accounts."
};

export default function DataDeletionPage() {
  return (
    <div className="stack">
      <section className="card stack" style={{ gap: 20 }}>
        <div className="stack" style={{ gap: 8 }}>
          <p className="eyebrow">Legal</p>
          <h1>Data Deletion Instructions</h1>
          <p className="muted">
            You can request deletion of your connected data and account records from Prosocial System using the
            steps below.
          </p>
        </div>

        <section className="stack" style={{ gap: 8 }}>
          <h2>1. Disconnect providers</h2>
          <p>
            Log in to the application, open connected accounts, and disconnect Facebook Pages or Google Drive to
            stop future access.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>2. Revoke provider permissions</h2>
          <p>
            Optionally revoke this app from your Facebook and Google account security settings to invalidate any
            remaining tokens.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>3. Request data deletion</h2>
          <p>
            Contact the operator of this deployment and include the email address used in the system, plus the
            workspace or page references you want removed. The operator can remove connected account records,
            content history, and automation configuration from the application database.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>4. What will be deleted</h2>
          <p>
            Deletion requests may include user profile records, access tokens, connected page metadata, Google
            Drive references, queued content, and operational history, except where retention is required for
            security or legal compliance.
          </p>
        </section>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/privacy-policy">Privacy Policy</Link>
          <Link href="/terms-of-service">Terms of Service</Link>
          <Link href="/login">Back to Login</Link>
        </div>
      </section>
    </div>
  );
}
