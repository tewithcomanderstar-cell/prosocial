"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useI18n } from "@/components/language-provider";

export function LogoutButton() {
  const router = useRouter();
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button className="button-secondary" type="button" onClick={handleLogout} disabled={loading}>
      {loading ? t("loginSigningOut") : t("loginLogout")}
    </button>
  );
}
