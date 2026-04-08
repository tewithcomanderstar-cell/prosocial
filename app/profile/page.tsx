"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { SectionCard } from "@/components/section-card";
import { useI18n } from "@/components/language-provider";

type ProfileUser = {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  hasPassword: boolean;
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
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    name: "",
    timezone: "Asia/Bangkok",
    locale: isThai ? "th-TH" : "en-US",
    avatar: ""
  });
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  });

  const copy = useMemo(
    () => ({
      title: isThai ? "โปรไฟล์ผู้ใช้" : "Profile",
      name: isThai ? "ชื่อ" : "Name",
      email: isThai ? "อีเมล" : "Email",
      provider: isThai ? "วิธีเข้าสู่ระบบ" : "Provider",
      role: isThai ? "สิทธิ์" : "Role",
      plan: isThai ? "แพ็กเกจ" : "Plan",
      timezone: isThai ? "โซนเวลา" : "Timezone",
      locale: isThai ? "ภาษา" : "Locale",
      pageLimit: isThai ? "จำนวนเพจสูงสุด" : "Page limit",
      save: isThai ? "บันทึกโปรไฟล์" : "Save profile",
      avatarTitle: isThai ? "รูปโปรไฟล์" : "Profile photo",
      avatarUpload: isThai ? "อัปโหลดรูปใหม่" : "Upload new photo",
      avatarUploading: isThai ? "กำลังอัปโหลด..." : "Uploading...",
      passwordTitle: isThai ? "เปลี่ยนรหัสผ่าน" : "Change password",
      currentPassword: isThai ? "รหัสผ่านปัจจุบัน" : "Current password",
      newPassword: isThai ? "รหัสผ่านใหม่" : "New password",
      confirmPassword: isThai ? "ยืนยันรหัสผ่านใหม่" : "Confirm new password",
      savePassword: isThai ? "อัปเดตรหัสผ่าน" : "Update password",
      passwordOnlySocial: isThai
        ? "บัญชีนี้ใช้ social login อย่างเดียว จึงยังเปลี่ยนรหัสผ่านจากหน้านี้ไม่ได้"
        : "This account uses social login only, so password change is unavailable here.",
      connectTitle: isThai ? "บัญชีที่เชื่อมต่อ" : "Connected accounts",
      connectAction: isThai ? "จัดการบัญชี" : "Manage accounts",
      saving: isThai ? "กำลังบันทึก..." : "Saving...",
      loading: isThai ? "กำลังโหลด..." : "Loading...",
      passwordMismatch: isThai ? "รหัสผ่านใหม่และยืนยันรหัสผ่านไม่ตรงกัน" : "New password and confirmation do not match",
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
        locale: nextUser.locale,
        avatar: nextUser.avatar || ""
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
    setForm((current) => ({ ...current, avatar: nextUser.avatar || "" }));
    setMessage(result.message || (isThai ? "บันทึกโปรไฟล์แล้ว" : "Profile updated"));
  }

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > 1_500_000) {
      setMessage(isThai ? "รูปต้องมีขนาดไม่เกิน 1.5 MB" : "Avatar must be 1.5 MB or smaller");
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const avatar = typeof reader.result === "string" ? reader.result : "";
      setAvatarUploading(true);
      setMessage("");

      const response = await fetch("/api/auth/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          timezone: form.timezone,
          locale: form.locale,
          avatar
        })
      });

      const result = await response.json();
      setAvatarUploading(false);

      if (!result.ok) {
        setMessage(result.message || (isThai ? "อัปโหลดรูปไม่สำเร็จ" : "Unable to upload avatar"));
        return;
      }

      const nextUser = result.data.user as ProfileUser;
      setUser(nextUser);
      setForm((current) => ({ ...current, avatar: nextUser.avatar || "" }));
      setMessage(isThai ? "อัปเดตรูปโปรไฟล์แล้ว" : "Avatar updated");
    };

    reader.readAsDataURL(file);
  }

  async function handlePasswordSave() {
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setMessage(copy.passwordMismatch);
      return;
    }

    setPasswordSaving(true);
    setMessage("");

    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword
      })
    });

    const result = await response.json();
    setPasswordSaving(false);

    if (!result.ok) {
      setMessage(result.message || (isThai ? "เปลี่ยนรหัสผ่านไม่สำเร็จ" : "Unable to change password"));
      return;
    }

    setPasswordForm({
      currentPassword: "",
      newPassword: "",
      confirmPassword: ""
    });
    setMessage(result.message || (isThai ? "เปลี่ยนรหัสผ่านแล้ว" : "Password updated"));
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

        <div className="profile-grid">
          <section className="profile-panel">
            <div className="stack">
              <strong>{copy.avatarTitle}</strong>
              <div className="profile-head">
                {user?.avatar ? (
                  <img src={user.avatar} alt={user.name} className="profile-avatar profile-avatar-large" />
                ) : (
                  <div className="profile-avatar profile-avatar-large profile-avatar-fallback">
                    {user?.name?.slice(0, 1).toUpperCase() || "U"}
                  </div>
                )}
                <label className="button-secondary profile-upload-button">
                  <input type="file" accept="image/*" className="profile-file-input" onChange={handleAvatarChange} />
                  {avatarUploading ? copy.avatarUploading : copy.avatarUpload}
                </label>
              </div>
            </div>
          </section>

          <section className="profile-panel">
            <div className="stack">
              <strong>{copy.connectTitle}</strong>
              <a className="button-secondary profile-link-button" href="/connected-accounts">
                {copy.connectAction}
              </a>
            </div>
          </section>
        </div>

        <section className="profile-panel">
          <div className="stack">
            <strong>{copy.passwordTitle}</strong>
            {user?.hasPassword ? (
              <div className="profile-password-grid">
                <label className="label">
                  {copy.currentPassword}
                  <input
                    className="input"
                    type="password"
                    value={passwordForm.currentPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                  />
                </label>

                <label className="label">
                  {copy.newPassword}
                  <input
                    className="input"
                    type="password"
                    value={passwordForm.newPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                  />
                </label>

                <label className="label">
                  {copy.confirmPassword}
                  <input
                    className="input"
                    type="password"
                    value={passwordForm.confirmPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  />
                </label>

                <button className="button" type="button" onClick={handlePasswordSave} disabled={passwordSaving}>
                  {passwordSaving ? copy.saving : copy.savePassword}
                </button>
              </div>
            ) : (
              <div className="muted">{copy.passwordOnlySocial}</div>
            )}
          </div>
        </section>

        {message ? <div className="composer-message">{message}</div> : null}
      </SectionCard>
    </div>
  );
}

