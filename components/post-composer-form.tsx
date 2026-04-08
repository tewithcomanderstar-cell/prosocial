"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/language-provider";

type Page = {
  pageId: string;
  name: string;
};

type DriveImage = {
  id: string;
  name: string;
};

type Variant = {
  caption: string;
  hashtags: string[];
};

type ActionMode = "draft" | "instant" | "auto";
type StartMode = "scheduled" | "delay";

export function PostComposerForm() {
  const { language, t } = useI18n();
  const isThai = language === "th";
  const [pages, setPages] = useState<Page[]>([]);
  const [images, setImages] = useState<DriveImage[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState<ActionMode | null>(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    title: "",
    content: "",
    hashtags: "",
    postingMode: "broadcast",
    targetPageIds: [] as string[],
    imageUrls: [] as string[],
    randomizeImages: false,
    randomizeCaption: false,
    keyword: "",
    personaPageId: "",
    autoEnabled: true,
    startMode: "scheduled" as StartMode,
    frequency: "once",
    intervalHours: 1,
    delayMinutes: 0,
    runAt: "",
    timezone: "Asia/Bangkok"
  });

  useEffect(() => {
    Promise.all([
      fetch("/api/facebook/pages").then((res) => res.json()),
      fetch("/api/google-drive/images").then((res) => res.json())
    ]).then(([pageResult, imageResult]) => {
      if (pageResult.ok) {
        setPages(pageResult.data.pages);
      }
      if (imageResult.ok) {
        setImages(imageResult.data.images);
      }
    });
  }, []);

  const copy = useMemo(
    () => ({
      workspaceEyebrow: isThai ? "โพสต์ง่ายขึ้นในหน้าเดียว" : "Simplified posting workspace",
      workspaceTitle: isThai ? "โพสต์ทันที หรือเปิดโหมดออโต้ได้จากหน้าเดียว" : "Post instantly or switch to auto mode from one page.",
      aiTitle: isThai ? "AI ช่วยเขียนโพสต์" : "AI content assistant",
      immediateTitle: isThai ? "โพสต์ทันที" : "Post now",
      autoTitle: isThai ? "โหมดโพสต์อัตโนมัติ" : "Auto-post mode",
      delayLabel: isThai ? "หน่วงเวลาก่อนเริ่ม (นาที)" : "Delay before first post (minutes)",
      startModeLabel: isThai ? "โหมดเริ่มต้น" : "Start mode",
      startModeScheduled: isThai ? "เลือกเวลาโพสต์เอง" : "Choose posting time",
      startModeDelay: isThai ? "เริ่มหลังหน่วงเวลา" : "Start after delay",
      intervalLabel: isThai ? "ความถี่ในการโพสต์" : "Posting frequency",
      hourlyLabel: isThai ? "ทุกกี่ชั่วโมง" : "Repeat every how many hours",
      useVariant: isThai ? "ใช้เวอร์ชันนี้" : "Use this version",
      saveDraft: isThai ? "บันทึกเป็นร่าง" : "Save draft",
      postNow: isThai ? "โพสต์ทันที" : "Post now",
      saveAuto: isThai ? "บันทึกเข้าโหมดอัตโนมัติ" : "Save to auto mode"
    }),
    [isThai]
  );

  function buildPayload() {
    return {
      title: form.title,
      content: form.content,
      hashtags: form.hashtags.split(/\s+/).filter(Boolean),
      targetPageIds: form.targetPageIds,
      imageUrls: form.imageUrls,
      randomizeImages: form.randomizeImages,
      randomizeCaption: form.randomizeCaption,
      postingMode: form.postingMode,
      variants
    };
  }

  async function handleGenerate() {
    if (!form.keyword.trim()) {
      return;
    }

    setGenerating(true);
    setMessage("");

    const response = await fetch("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: form.keyword, pageId: form.personaPageId || undefined })
    });

    const result = await response.json();
    setGenerating(false);
    if (result.ok) {
      setVariants(result.data.variants || []);
      return;
    }

    setMessage(result.message || t("commonRequestFailed"));
  }

  function applyVariant(variant: Variant) {
    setForm((current) => ({ ...current, content: variant.caption, hashtags: variant.hashtags.join(" ") }));
  }

  async function submitDraft() {
    const response = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload())
    });

    const result = await response.json();
    setMessage(result.message || (result.ok ? copy.saveDraft : t("commonRequestFailed")));
  }

  async function submitInstant() {
    const response = await fetch("/api/posts/instant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload())
    });

    const result = await response.json();
    setMessage(result.message || (result.ok ? copy.postNow : t("commonRequestFailed")));
  }

  async function submitAuto() {
    const postResponse = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload())
    });
    const postResult = await postResponse.json();

    if (!postResult.ok) {
      setMessage(postResult.message || t("commonRequestFailed"));
      return;
    }

    const scheduleResponse = await fetch("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postId: postResult.data.postId,
        frequency: form.frequency,
        runAt: form.runAt ? new Date(form.runAt).toISOString() : undefined,
        timezone: form.timezone,
        intervalHours: form.frequency === "hourly" ? form.intervalHours : undefined,
        delayMinutes: form.delayMinutes,
        startMode: form.startMode
      })
    });
    const scheduleResult = await scheduleResponse.json();
    setMessage(scheduleResult.message || (scheduleResult.ok ? copy.saveAuto : t("commonRequestFailed")));
  }

  async function handleAction(mode: ActionMode) {
    if (!form.title || !form.content || form.targetPageIds.length === 0) {
      setMessage(isThai ? "กรอกชื่อโพสต์ ข้อความ และเลือกเพจอย่างน้อย 1 เพจก่อน" : "Please enter a title, content, and choose at least one target page.");
      return;
    }

    if (mode === "auto" && form.startMode === "scheduled" && !form.runAt) {
      setMessage(isThai ? "กรุณาเลือกเวลาโพสต์สำหรับโหมดอัตโนมัติ" : "Please choose the posting time for auto mode.");
      return;
    }

    setSaving(mode);
    setMessage("");

    try {
      if (mode === "draft") {
        await submitDraft();
      } else if (mode === "instant") {
        await submitInstant();
      } else {
        await submitAuto();
      }
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="stack">
      <div className="grid cols-2">
        <section className="card">
          <div className="section-head">
            <div>
              <h2>{copy.aiTitle}</h2>
            </div>
          </div>

          <div className="form">
            <label className="label">
              {t("aiKeyword")}
              <input className="input" value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} placeholder={t("aiKeywordPlaceholder")} />
            </label>

            <label className="label">
              {isThai ? "ใช้ persona ของเพจ" : "Use page persona"}
              <select className="select" value={form.personaPageId} onChange={(e) => setForm({ ...form, personaPageId: e.target.value })}>
                <option value="">{isThai ? "ไม่เลือก persona เฉพาะเพจ" : "No specific persona"}</option>
                {pages.map((page) => (
                  <option key={page.pageId} value={page.pageId}>{page.name}</option>
                ))}
              </select>
            </label>

            <button className="button" type="button" onClick={handleGenerate} disabled={generating}>
              {generating ? t("aiGenerating") : t("aiGenerate")}
            </button>
          </div>

          <div className="variants">
            {variants.map((variant, index) => (
              <article key={index} className="variant stack">
                <strong>{isThai ? `ตัวเลือก ${index + 1}` : `Option ${index + 1}`}</strong>
                <p>{variant.caption}</p>
                <p className="muted">{variant.hashtags.join(" ")}</p>
                <button className="button-secondary" type="button" onClick={() => applyVariant(variant)}>
                  {copy.useVariant}
                </button>
              </article>
            ))}
            {variants.length === 0 ? <div className="variant"><strong>{isThai ? "ยังไม่มีตัวเลือก" : "No variants yet"}</strong></div> : null}
          </div>
        </section>

        <form className="card form" onSubmit={(event: FormEvent<HTMLFormElement>) => event.preventDefault()}>
          <div className="section-head">
            <div>
              <h2>{isThai ? "ตั้งค่าโพสต์" : "Post setup"}</h2>
            </div>
          </div>

          <label className="label">
            {t("composePostTitle")}
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("composePostTitlePlaceholder")} required />
          </label>

          <label className="label">
            {t("composeCaption")}
            <textarea className="textarea" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder={t("composeCaptionPlaceholder")} required />
          </label>

          <label className="label">
            {t("composeHashtags")}
            <input className="input" value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} placeholder={t("composeHashtagsPlaceholder")} />
          </label>

          <label className="label">
            {t("composeMode")}
            <select className="select" value={form.postingMode} onChange={(e) => setForm({ ...form, postingMode: e.target.value })}>
              <option value="broadcast">{t("composeModeBroadcast")}</option>
              <option value="random-page">{t("composeModeRandom")}</option>
            </select>
          </label>

          <label className="label">
            {t("composePages")}
            <select className="select" multiple size={Math.max(4, pages.length || 4)} value={form.targetPageIds} onChange={(e) => setForm({ ...form, targetPageIds: Array.from(e.target.selectedOptions).map((option) => option.value) })}>
              {pages.map((page) => (
                <option key={page.pageId} value={page.pageId}>{page.name}</option>
              ))}
            </select>
          </label>

          <label className="label">
            {t("composeImages")}
            <select className="select" multiple size={Math.max(4, images.length || 4)} value={form.imageUrls} onChange={(e) => setForm({ ...form, imageUrls: Array.from(e.target.selectedOptions).map((option) => option.value) })}>
              {images.map((image) => (
                <option key={image.id} value={`drive:${image.id}`}>{image.name}</option>
              ))}
            </select>
          </label>

          <label className="list-item">
            <span>{t("composeRandomImage")}</span>
            <input type="checkbox" checked={form.randomizeImages} onChange={(e) => setForm({ ...form, randomizeImages: e.target.checked })} />
          </label>

          <label className="list-item">
            <span>{t("composeRandomCaption")}</span>
            <input type="checkbox" checked={form.randomizeCaption} onChange={(e) => setForm({ ...form, randomizeCaption: e.target.checked })} />
          </label>

          <section className="variant stack">
            <strong>{copy.immediateTitle}</strong>
            <button className="button" type="button" disabled={saving !== null} onClick={() => handleAction("instant")}>
              {saving === "instant" ? (isThai ? "กำลังโพสต์..." : "Posting...") : copy.postNow}
            </button>
          </section>

          <section className="variant stack">
            <strong>{copy.autoTitle}</strong>

            <label className="label">
              {copy.startModeLabel}
              <select className="select" value={form.startMode} onChange={(e) => setForm({ ...form, startMode: e.target.value as StartMode })}>
                <option value="scheduled">{copy.startModeScheduled}</option>
                <option value="delay">{copy.startModeDelay}</option>
              </select>
            </label>

            {form.startMode === "scheduled" ? (
              <label className="label">
                {t("scheduleTime")}
                <input className="input" type="datetime-local" value={form.runAt} onChange={(e) => setForm({ ...form, runAt: e.target.value })} />
              </label>
            ) : (
              <label className="label">
                {copy.delayLabel}
                <input className="input" type="number" min="0" value={form.delayMinutes} onChange={(e) => setForm({ ...form, delayMinutes: Number(e.target.value) })} />
              </label>
            )}

            <label className="label">
              {copy.intervalLabel}
              <select className="select" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                <option value="once">{t("scheduleOneTime")}</option>
                <option value="hourly">{isThai ? "ทุก X ชั่วโมง" : "Every X hours"}</option>
                <option value="daily">{t("scheduleEveryDay")}</option>
                <option value="weekly">{t("scheduleEveryWeek")}</option>
              </select>
            </label>

            {form.frequency === "hourly" ? (
              <label className="label">
                {copy.hourlyLabel}
                <select className="select" value={form.intervalHours} onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) })}>
                  <option value="1">1 {isThai ? "ชั่วโมง" : "hour"}</option>
                  <option value="2">2 {isThai ? "ชั่วโมง" : "hours"}</option>
                  <option value="3">3 {isThai ? "ชั่วโมง" : "hours"}</option>
                </select>
              </label>
            ) : null}

            <label className="label">
              {t("scheduleTimezone")}
              <input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            </label>

            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("auto")}>
              {saving === "auto" ? (isThai ? "กำลังบันทึก..." : "Saving...") : copy.saveAuto}
            </button>
          </section>

          <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("draft")}>
            {saving === "draft" ? (isThai ? "กำลังบันทึก..." : "Saving...") : copy.saveDraft}
          </button>

          {message ? <p className="muted">{message}</p> : null}
        </form>
      </div>
    </div>
  );
}

