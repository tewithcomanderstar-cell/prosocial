"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

type ProfileUser = {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  provider: string;
  role: string;
  timezone: string;
  locale: string;
  plan: string;
  subscriptionStatus: string;
  pageLimit: number;
  createdAt: string;
};

export default function ProfilePage() {
  const { language } = useI18n();
  const isThai = language === "th";
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    name: "",
    timezone: "Asia/Bangkok",
    locale: isThai ? "th-TH" : "en-US"
  });

  const copy = useMemo(
    () => ({
      title: isThai ? "โปรไฟล์ผู้ใช้" : "Profile",
      accountTitle: isThai ? "ข้อมูลบัญชี" : "Account",
      settingsTitle: isThai ? "การตั้งค่าส่วนตัว" : "Preferences",
      name: isThai ? "ชื่อ" : "Name",
      email: isThai ? "อีเมล" : "Email",
      provider: isThai ? "วิธีเข้าสู่ระบบ" : "Provider",
      role: isThai ? "สิทธิ์" : "Role",
      plan: isThai ? "แพ็กเกจ" : "Plan",
      timezone: isThai ? "โซนเวลา" : "Timezone",
      locale: isThai ? "ภาษา" : "Locale",
      pageLimit: isThai ? "จำนวนเพจสูงสุด" : "Page limit",
      save: isThai ? "บันทึกโปรไฟล์" : "Save profile",
      saving: isThai ? "กำลังบันทึก..." : "Saving...",
      loading: isThai ? "กำลังโหลด..." : "Loading...",
      noAvatar: isThai ? "ไม่มีรูป" : "No avatar",
      joined: isThai ? "สร้างบัญชีเมื่อ" : "Joined",
      th: isThai ? "ไทย" : "Thai",
      en: isThai ? "อังกฤษ" : "English"
    }),
    [isThai]
  );

  useEffect(() => {
    async function loadProfile() {
      setLoading(true);
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      const result = await response.json();
      setLoading(false);

      if (!result.ok) {
        setMessage(result.message || (isThai ? "ไม่สามารถโหลดโปรไฟล์ได้" : "Unable to load profile"));
        return;
      }

      const nextUser = result.data.user as ProfileUser;
      setUser(nextUser);
      setForm({
        name: nextUser.name,
        timezone: nextUser.timezone,
        locale: nextUser.locale
      });
    }

    loadProfile();
  }, [isThai]);

  async function handleSave() {
    setSaving(true);
    setMessage("");

    const response = await fetch("/api/auth/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });

    const result = await response.json();
    setSaving(false);

    if (!result.ok) {
      setMessage(result.message || (isThai ? "บันทึกโปรไฟล์ไม่สำเร็จ" : "Unable to save profile"));
      return;
    }

    const nextUser = result.data.user as ProfileUser;
    setUser(nextUser);
    setMessage(result.message || (isThai ? "บันทึกโปรไฟล์แล้ว" : "Profile updated"));
  }

  if (loading) {
    return (
      <div className="stack">
        <SectionCard title={copy.title} icon="profile">
          <div className="muted">{copy.loading}</div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="stack">
      <SectionCard title={copy.title} icon="profile">
        <div className="profile-grid">
          <section className="profile-panel">
            <div className="profile-head">
              {user?.avatar ? (
                <img src={user.avatar} alt={user.name} className="profile-avatar" />
              ) : (
                <div className="profile-avatar profile-avatar-fallback">
                  {user?.name?.slice(0, 1).toUpperCase() || "U"}
                </div>
              )}
              <div className="stack">
                <strong>{user?.name}</strong>
                <span className="muted">{user?.email}</span>
              </div>
            </div>

            <div className="profile-meta-grid">
              <div className="summary-pill"><span>{copy.provider}</span><strong>{user?.provider || "-"}</strong></div>
              <div className="summary-pill"><span>{copy.role}</span><strong>{user?.role || "-"}</strong></div>
              <div className="summary-pill"><span>{copy.plan}</span><strong>{user?.plan || "-"}</strong></div>
              <div className="summary-pill"><span>{copy.pageLimit}</span><strong>{user?.pageLimit ?? "-"}</strong></div>
            </div>

            <div className="muted">
              {copy.joined}: {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-"}
            </div>
          </section>

          <section className="profile-panel">
            <div className="form">
              <label className="label">
                {copy.name}
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>

              <label className="label">
                {copy.timezone}
                <input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
              </label>

              <label className="label">
                {copy.locale}
                <select className="select" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
                  <option value="th-TH">{copy.th}</option>
                  <option value="en-US">{copy.en}</option>
                </select>
              </label>

              <button className="button" type="button" onClick={handleSave} disabled={saving}>
                {saving ? copy.saving : copy.save}
              </button>
            </div>
          </section>
        </div>

        {message ? <div className="composer-message">{message}</div> : null}
      </SectionCard>
    </div>
  );
}
