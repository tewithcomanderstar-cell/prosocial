"use client";

import { useI18n } from "@/components/language-provider";

export default function PrivacyPolicyPage() {
  const { t } = useI18n();

  return (
    <div className="stack">
      <section className="card">
        <div className="stack">
          <h2>{t("privacySummary")}</h2>
          <p>
            We collect only the minimum account, page, and Google Drive access information required to let
            authenticated users connect their services, browse folders, and publish scheduled Facebook posts.
          </p>
          <p>
            Access tokens are stored in your application database and used solely for the requested automation
            features. You may revoke access at any time from your Facebook and Google account settings.
          </p>
          <p>
            This application does not sell personal data. Operators are responsible for ensuring their content
            complies with Facebook Platform Terms, Google API Services User Data Policy, and local laws.
          </p>
        </div>
      </section>
    </div>
  );
}

