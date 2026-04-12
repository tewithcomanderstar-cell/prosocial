import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | Prosocial System",
  description: "Privacy Policy for Prosocial System covering Facebook, Google Drive, and account authentication usage."
};

export default function PrivacyPolicyPage() {
  return (
    <div className="stack">
      <section className="card stack" style={{ gap: 20 }}>
        <div className="stack" style={{ gap: 8 }}>
          <p className="eyebrow">Legal</p>
          <h1>Privacy Policy</h1>
          <p className="muted">
            Effective date: April 13, 2026. This policy explains how Prosocial System collects, stores,
            and uses account, Facebook, and Google Drive data to provide publishing automation features.
          </p>
        </div>

        <section className="stack" style={{ gap: 8 }}>
          <h2>1. Information we collect</h2>
          <p>
            We collect account details such as your name, email address, profile image, and login provider.
            When you connect Facebook Pages or Google Drive, we also store the minimum tokens, page data,
            folder references, and file metadata required to run the features you explicitly enable.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>2. How we use your data</h2>
          <p>We use your data to:</p>
          <ul className="list">
            <li className="list-item">Authenticate you into the application</li>
            <li className="list-item">Connect and manage Facebook Pages and Google Drive folders</li>
            <li className="list-item">Generate captions, schedule posts, and publish approved content</li>
            <li className="list-item">Track job history, failures, notifications, and audit logs</li>
          </ul>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>3. Facebook and Google data usage</h2>
          <p>
            Facebook and Google access tokens are used only for the features you authorize. We do not sell,
            rent, or share your connected account data for advertising. Access may be revoked at any time from
            your Facebook or Google security settings, or by disconnecting the provider inside the product.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>4. Storage and retention</h2>
          <p>
            We store operational data such as workspace records, content items, publishing history, tokens,
            and audit logs in our application database to support normal platform operation, troubleshooting,
            and security review. We keep data only as long as necessary for the service or legal obligations.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>5. Your choices</h2>
          <p>
            You may request to disconnect providers, stop automation, or delete account data. For Facebook
            data deletion instructions, see our <Link href="/data-deletion">Data Deletion page</Link>.
          </p>
        </section>

        <section className="stack" style={{ gap: 8 }}>
          <h2>6. Contact</h2>
          <p>
            For privacy or data access requests, contact the operator of this deployment using the support
            channel associated with your workspace, or via the account management team responsible for this app.
          </p>
        </section>

        <div className="stack" style={{ gap: 6 }}>
          <p className="muted">Related documents</p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Link href="/terms-of-service">Terms of Service</Link>
            <Link href="/data-deletion">Data Deletion</Link>
            <Link href="/login">Back to Login</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
