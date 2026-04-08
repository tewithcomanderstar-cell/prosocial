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
      aiTitle: isThai ? "AI ช่วยเขียนโพสต์" : "AI assistant",
      contentTitle: isThai ? "คอนเทนต์" : "Content",
      targetTitle: isThai ? "เพจและรูปภาพ" : "Pages and media",
      deliveryTitle: isThai ? "วิธีโพสต์" : "Delivery",
      queueTitle: isThai ? "พร้อมโพสต์" : "Ready to post",
      selectedPages: isThai ? "เพจ" : "Pages",
      selectedImages: isThai ? "รูป" : "Images",
      noSelection: isThai ? "ยังไม่ได้เลือก" : "Not selected",
      noVariants: isThai ? "ยังไม่มีตัวเลือก" : "No variants yet",
      useVariant: isThai ? "ใช้ตัวเลือกนี้" : "Use this",
      saveDraft: isThai ? "บันทึกร่าง" : "Save draft",
      postNow: isThai ? "โพสต์ทันที" : "Post now",
      saveAuto: isThai ? "เปิดโพสต์อัตโนมัติ" : "Enable auto post",
      postingModeTitle: isThai ? "รูปแบบการลงเพจ" : "Publishing mode",
      quickSchedule: isThai ? "ตั้งเวลาเร็ว" : "Quick schedule",
      quickHour1: isThai ? "ทุก 1 ชม." : "Every 1h",
      quickHour2: isThai ? "ทุก 2 ชม." : "Every 2h",
      quickHour3: isThai ? "ทุก 3 ชม." : "Every 3h",
      chooseTime: isThai ? "เลือกเวลาเอง" : "Pick time",
      startAfterDelay: isThai ? "เริ่มหลังหน่วงเวลา" : "Start after delay",
      delayLabel: isThai ? "หน่วงเวลา (นาที)" : "Delay (minutes)",
      hourlyLabel: isThai ? "ทุกกี่ชั่วโมง" : "Every how many hours",
      usePersona: isThai ? "ใช้ persona ของเพจ" : "Use page persona",
      noPersona: isThai ? "ไม่เลือก persona" : "No persona",
      broadcast: isThai ? "1 โพสต์ลงหลายเพจ" : "1 post to many pages",
      randomPages: isThai ? "สุ่มเพจปลายทาง" : "Random target pages",
      imageMode: isThai ? "สุ่มรูป" : "Random images",
      captionMode: isThai ? "สุ่มข้อความ" : "Random captions",
      autoSummary: isThai ? "อัตโนมัติ" : "Auto",
      instantSummary: isThai ? "ทันที" : "Instant",
      selectPagesHint: isThai ? "เลือกเพจที่ต้องการโพสต์" : "Choose target pages",
      selectImagesHint: isThai ? "เลือกรูปได้หลายรูป" : "Choose multiple images"
    }),
    [isThai]
  );

  const selectedPageNames = useMemo(
    () => pages.filter((page) => form.targetPageIds.includes(page.pageId)).map((page) => page.name),
    [pages, form.targetPageIds]
  );

  const selectedImageNames = useMemo(
    () => images.filter((image) => form.imageUrls.includes(`drive:${image.id}`)).map((image) => image.name),
    [images, form.imageUrls]
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
    setForm((current) => ({
      ...current,
      content: variant.caption,
      hashtags: variant.hashtags.join(" ")
    }));
  }

  function toggleMultiValue(value: string, currentValues: string[], field: "targetPageIds" | "imageUrls") {
    setForm((current) => ({
      ...current,
      [field]: currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues, value]
    }));
  }

  function applyQuickHourly(intervalHours: number) {
    setForm((current) => ({
      ...current,
      frequency: "hourly",
      intervalHours,
      startMode: "delay",
      delayMinutes: current.delayMinutes === 0 ? 10 : current.delayMinutes
    }));
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
    <form className="stack composer-shell" onSubmit={(event: FormEvent<HTMLFormElement>) => event.preventDefault()}>
      <section className="card composer-summary">
        <div className="section-head composer-summary-head">
          <div>
            <h2>{copy.queueTitle}</h2>
          </div>
          <div className="composer-actions">
            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("draft")}>
              {saving === "draft" ? (isThai ? "กำลังบันทึก..." : "Saving...") : copy.saveDraft}
            </button>
            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("auto")}>
              {saving === "auto" ? (isThai ? "กำลังบันทึก..." : "Saving...") : copy.saveAuto}
            </button>
            <button className="button" type="button" disabled={saving !== null} onClick={() => handleAction("instant")}>
              {saving === "instant" ? (isThai ? "กำลังโพสต์..." : "Posting...") : copy.postNow}
            </button>
          </div>
        </div>

        <div className="composer-summary-grid">
          <div className="summary-pill">
            <span>{copy.selectedPages}</span>
            <strong>{selectedPageNames.length || 0}</strong>
          </div>
          <div className="summary-pill">
            <span>{copy.selectedImages}</span>
            <strong>{selectedImageNames.length || 0}</strong>
          </div>
          <div className="summary-pill">
            <span>{isThai ? "ความถี่" : "Frequency"}</span>
            <strong>
              {form.frequency === "hourly"
                ? `${form.intervalHours}${isThai ? " ชม." : "h"}`
                : form.frequency === "daily"
                  ? (isThai ? "รายวัน" : "Daily")
                  : form.frequency === "weekly"
                    ? (isThai ? "รายสัปดาห์" : "Weekly")
                    : (isThai ? "ครั้งเดียว" : "Once")}
            </strong>
          </div>
          <div className="summary-pill">
            <span>{isThai ? "โหมด" : "Mode"}</span>
            <strong>{form.startMode === "delay" || form.runAt ? copy.autoSummary : copy.instantSummary}</strong>
          </div>
        </div>

        {message ? <div className="composer-message">{message}</div> : null}
      </section>

      <div className="grid cols-2 composer-grid">
        <section className="card stack">
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
              {copy.usePersona}
              <select className="select" value={form.personaPageId} onChange={(e) => setForm({ ...form, personaPageId: e.target.value })}>
                <option value="">{copy.noPersona}</option>
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
            {variants.length === 0 ? <div className="variant"><strong>{copy.noVariants}</strong></div> : null}
          </div>
        </section>

        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>{copy.contentTitle}</h2>
            </div>
          </div>

          <div className="form">
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
          </div>
        </section>

        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>{copy.targetTitle}</h2>
            </div>
          </div>

          <div className="stack">
            <div className="label">
              <span>{copy.selectPagesHint}</span>
              <div className="chip-grid">
                {pages.map((page) => {
                  const active = form.targetPageIds.includes(page.pageId);
                  return (
                    <button key={page.pageId} type="button" className={`choice-chip ${active ? "active" : ""}`} onClick={() => toggleMultiValue(page.pageId, form.targetPageIds, "targetPageIds")}>
                      {page.name}
                    </button>
                  );
                })}
                {pages.length === 0 ? <div className="muted">{copy.noSelection}</div> : null}
              </div>
            </div>

            <div className="label">
              <span>{copy.selectImagesHint}</span>
              <div className="chip-grid">
                {images.map((image) => {
                  const value = `drive:${image.id}`;
                  const active = form.imageUrls.includes(value);
                  return (
                    <button key={image.id} type="button" className={`choice-chip ${active ? "active" : ""}`} onClick={() => toggleMultiValue(value, form.imageUrls, "imageUrls")}>
                      {image.name}
                    </button>
                  );
                })}
                {images.length === 0 ? <div className="muted">{copy.noSelection}</div> : null}
              </div>
            </div>

            <div className="toggle-grid">
              <label className="list-item">
                <span>{copy.imageMode}</span>
                <input type="checkbox" checked={form.randomizeImages} onChange={(e) => setForm({ ...form, randomizeImages: e.target.checked })} />
              </label>

              <label className="list-item">
                <span>{copy.captionMode}</span>
                <input type="checkbox" checked={form.randomizeCaption} onChange={(e) => setForm({ ...form, randomizeCaption: e.target.checked })} />
              </label>
            </div>

            <label className="label">
              {copy.postingModeTitle}
              <select className="select" value={form.postingMode} onChange={(e) => setForm({ ...form, postingMode: e.target.value })}>
                <option value="broadcast">{copy.broadcast}</option>
                <option value="random-page">{copy.randomPages}</option>
              </select>
            </label>
          </div>
        </section>

        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>{copy.deliveryTitle}</h2>
            </div>
          </div>

          <div className="stack">
            <div className="label">
              <span>{copy.quickSchedule}</span>
              <div className="chip-grid chip-grid-compact">
                <button type="button" className={`choice-chip ${form.frequency === "hourly" && form.intervalHours === 1 ? "active" : ""}`} onClick={() => applyQuickHourly(1)}>{copy.quickHour1}</button>
                <button type="button" className={`choice-chip ${form.frequency === "hourly" && form.intervalHours === 2 ? "active" : ""}`} onClick={() => applyQuickHourly(2)}>{copy.quickHour2}</button>
                <button type="button" className={`choice-chip ${form.frequency === "hourly" && form.intervalHours === 3 ? "active" : ""}`} onClick={() => applyQuickHourly(3)}>{copy.quickHour3}</button>
              </div>
            </div>

            <div className="toggle-grid">
              <button type="button" className={`mode-card ${form.startMode === "scheduled" ? "active" : ""}`} onClick={() => setForm({ ...form, startMode: "scheduled" })}>
                <strong>{copy.chooseTime}</strong>
                <span>{form.runAt || copy.noSelection}</span>
              </button>
              <button type="button" className={`mode-card ${form.startMode === "delay" ? "active" : ""}`} onClick={() => setForm({ ...form, startMode: "delay" })}>
                <strong>{copy.startAfterDelay}</strong>
                <span>{form.delayMinutes}{isThai ? " นาที" : " min"}</span>
              </button>
            </div>

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
              {isThai ? "รูปแบบการโพสต์ซ้ำ" : "Repeat"}
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
          </div>
        </section>
      </div>
    </form>
  );
}
