"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/language-provider";

type Page = {
  pageId: string;
  name: string;
};

type DriveFolder = {
  id: string;
  name: string;
};

type DriveImage = {
  id: string;
  name: string;
  webContentLink?: string;
  thumbnailLink?: string;
  webViewLink?: string;
};

type UploadedImage = {
  id: string;
  name: string;
  ref: string;
  mimeType?: string;
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [folderImages, setFolderImages] = useState<DriveImage[]>([]);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState<ActionMode | null>(null);
  const [uploading, setUploading] = useState(false);
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
    selectedDriveFolderId: "root",
    startMode: "scheduled" as StartMode,
    frequency: "once",
    intervalHours: 1,
    delayMinutes: 0,
    runAt: "",
    timezone: "Asia/Bangkok"
  });

  useEffect(() => {
    Promise.all([
      fetch("/api/facebook/pages", { cache: "no-store" }).then((res) => res.json()),
      fetch("/api/google-drive/folders", { cache: "no-store" }).then((res) => res.json())
    ]).then(([pageResult, folderResult]) => {
      if (pageResult.ok) {
        setPages(pageResult.data.pages);
      }
      if (folderResult.ok) {
        setFolders(folderResult.data.folders);
      }
    });
  }, []);

  useEffect(() => {
    if (!form.selectedDriveFolderId) {
      return;
    }

    fetch(`/api/google-drive/images?folderId=${form.selectedDriveFolderId}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setFolderImages(result.data.images);
        }
      });
  }, [form.selectedDriveFolderId]);

  const copy = useMemo(
    () => ({
      aiTitle: isThai ? "AI ช่วยเขียนโพสต์" : "AI assistant",
      contentTitle: isThai ? "ตัวเขียนโพสต์" : "Post composer",
      targetTitle: isThai ? "ปลายทางและสื่อ" : "Destinations and media",
      deliveryTitle: isThai ? "การเผยแพร่" : "Publishing",
      queueTitle: isThai ? "พร้อมโพสต์" : "Ready to post",
      selectedPages: isThai ? "เพจ" : "Pages",
      selectedImages: isThai ? "รูป" : "Images",
      noSelection: isThai ? "ยังไม่ได้เลือก" : "Not selected",
      noVariants: isThai ? "ยังไม่มีตัวเลือก" : "No variants yet",
      useVariant: isThai ? "ใช้ตัวเลือกนี้" : "Use this",
      saveDraft: isThai ? "บันทึกร่าง" : "Save draft",
      postNow: isThai ? "โพสต์ทันที" : "Post now",
      saveAuto: isThai ? "ตั้งโพสต์อัตโนมัติ" : "Enable auto post",
      postingModeTitle: isThai ? "รูปแบบการกระจายโพสต์" : "Distribution mode",
      quickSchedule: isThai ? "ตั้งเวลาเร็ว" : "Quick schedule",
      quickHour1: isThai ? "ทุก 1 ชม." : "Every 1h",
      quickHour2: isThai ? "ทุก 2 ชม." : "Every 2h",
      quickHour3: isThai ? "ทุก 3 ชม." : "Every 3h",
      chooseTime: isThai ? "กำหนดเวลาเอง" : "Schedule manually",
      startAfterDelay: isThai ? "เริ่มหลังหน่วงเวลา" : "Start after delay",
      delayLabel: isThai ? "หน่วงเวลา (นาที)" : "Delay (minutes)",
      hourlyLabel: isThai ? "ทุกกี่ชั่วโมง" : "Every how many hours",
      usePersona: isThai ? "ใช้ persona ของเพจ" : "Use page persona",
      noPersona: isThai ? "ไม่เลือก persona" : "No persona",
      broadcast: isThai ? "โพสต์เดียวลงหลายเพจ" : "1 post to many pages",
      randomPages: isThai ? "สุ่มเพจปลายทาง" : "Random target page",
      imageMode: isThai ? "สุ่มรูป" : "Random images",
      captionMode: isThai ? "สุ่มข้อความ" : "Random captions",
      autoSummary: isThai ? "อัตโนมัติ" : "Automated",
      instantSummary: isThai ? "ทันที" : "Instant",
      selectPagesHint: isThai ? "เลือกเพจที่จะลงโพสต์แบบเดียวกับเลือกปลายทางใน Facebook Business" : "Choose the pages you want to publish to.",
      selectImagesHint: isThai ? "เลือกรูปที่ต้องการใช้ในโพสต์นี้" : "Choose the media for this post.",
      audiencePublic: isThai ? "สาธารณะ" : "Public",
      audienceFollowers: isThai ? "ผู้ติดตาม" : "Followers",
      audienceTeam: isThai ? "ทีมงาน" : "Team only",
      fbPrompt: isThai ? "คุณกำลังคิดอะไรอยู่" : "What is on your mind?",
      addToPost: isThai ? "เพิ่มในโพสต์ของคุณ" : "Add to your post",
      fbPreview: isThai ? "ตัวอย่างแบบ Facebook" : "Facebook preview",
      postTitleHint: isThai ? "หัวข้อภายในระบบ" : "Internal title",
      titleOptional: isThai ? "ใช้จัดการคิวภายใน ไม่แสดงใน Facebook" : "For your internal queue only.",
      variantsHint: isThai ? "เลือกสไตล์ที่ AI สร้างแล้วดึงมาใส่โพสต์ด้านซ้ายได้ทันที" : "Pick an AI variant and apply it to the post instantly.",
      postingStatus: isThai ? "สถานะการเผยแพร่" : "Publishing status",
      mediaEmpty: isThai ? "ยังไม่ได้เลือกรูป ระบบจะโพสต์แบบข้อความหรือใช้ค่าเริ่มต้นตาม flow" : "No media selected yet.",
      like: isThai ? "ถูกใจ" : "Like",
      comment: isThai ? "แสดงความคิดเห็น" : "Comment",
      share: isThai ? "แชร์" : "Share",
      atAGlance: isThai ? "ภาพรวม" : "At a glance",
      myDriveFolder: isThai ? "โฟลเดอร์ในไดรฟ์ของฉัน" : "Folder in My Drive",
      chooseDriveFolder: isThai ? "เลือกโฟลเดอร์จาก Google Drive" : "Choose a Google Drive folder",
      syncFolderImages: isThai ? "ใช้รูปทั้งหมดในโฟลเดอร์นี้" : "Use all images in this folder",
      uploadFromDevice: isThai ? "แนบรูปจากคอม/มือถือ" : "Attach from device",
      uploadedMedia: isThai ? "รูปที่อัปโหลดจากอุปกรณ์" : "Uploaded device media",
      uploadingMedia: isThai ? "กำลังอัปโหลดรูป..." : "Uploading images...",
      imagePoolHint: isThai ? "เมื่อเปิดสุ่มรูป ระบบจะสุ่มจากรูปที่เลือกและรูปจากโฟลเดอร์นี้" : "When random images is on, the system will randomize from the selected pool.",
      drivePool: isThai ? "คลังรูปจาก Google Drive" : "Google Drive image pool",
      postSourceHint: isThai ? "โหมดโพสต์ทันทีรองรับรูปจากคอม มือถือ และ Google Drive แล้ว" : "Instant posting now supports device uploads and Google Drive media."
    }),
    [isThai]
  );

  const selectedPages = useMemo(
    () => pages.filter((page) => form.targetPageIds.includes(page.pageId)),
    [pages, form.targetPageIds]
  );

  const allImageOptions = useMemo(() => {
    const driveOptions = folderImages.map((image) => ({ ref: `drive:${image.id}`, name: image.name, source: "drive" as const }));
    const uploadOptions = uploadedImages.map((image) => ({ ref: image.ref, name: image.name, source: "upload" as const }));
    return [...uploadOptions, ...driveOptions];
  }, [folderImages, uploadedImages]);

  const selectedImageNames = useMemo(
    () => allImageOptions.filter((image) => form.imageUrls.includes(image.ref)).map((image) => image.name),
    [allImageOptions, form.imageUrls]
  );

  const previewCaption = useMemo(() => {
    const hashtagText = form.hashtags.trim();
    return [form.content.trim(), hashtagText].filter(Boolean).join("\n\n");
  }, [form.content, form.hashtags]);

  const primaryPageName = selectedPages[0]?.name || (isThai ? "เลือกเพจอย่างน้อย 1 เพจ" : "Choose at least one page");

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

  function useDriveFolderAsImagePool() {
    const folderRefs = folderImages.map((image) => `drive:${image.id}`);
    setForm((current) => ({
      ...current,
      imageUrls: Array.from(new Set([...current.imageUrls.filter((item) => !item.startsWith("drive:")), ...folderRefs])),
      randomizeImages: true
    }));
    setMessage(isThai ? "ดึงรูปจากโฟลเดอร์ Google Drive มาเป็นคลังสุ่มรูปแล้ว" : "Google Drive folder synced as random image pool.");
  }

  async function handleUploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    setUploading(true);
    setMessage("");

    const body = new FormData();
    Array.from(files).forEach((file) => body.append("files", file));

    const response = await fetch("/api/media-library/upload", {
      method: "POST",
      body
    });

    const result = await response.json();
    setUploading(false);

    if (!result.ok) {
      setMessage(result.message || t("commonRequestFailed"));
      return;
    }

    const uploads = (result.data.uploads ?? []) as UploadedImage[];
    setUploadedImages((current) => [...uploads, ...current]);
    setForm((current) => ({
      ...current,
      imageUrls: Array.from(new Set([...current.imageUrls, ...uploads.map((upload) => upload.ref)]))
    }));
    setMessage(isThai ? "อัปโหลดรูปจากอุปกรณ์แล้ว" : "Uploaded images from your device.");
    event.target.value = "";
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
    <form className="stack composer-shell composer-shell-fb" onSubmit={(event: FormEvent<HTMLFormElement>) => event.preventDefault()}>
      <section className="card composer-summary composer-summary-fb">
        <div className="section-head composer-summary-head composer-summary-head-fb">
          <div>
            <p className="eyebrow">{copy.atAGlance}</p>
            <h2>{copy.queueTitle}</h2>
            <p className="section-copy">{copy.postSourceHint}</p>
          </div>
          <div className="composer-actions">
            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("draft")}>
              {saving === "draft" ? (isThai ? "กำลังบันทึก..." : "Saving...") : copy.saveDraft}
            </button>
            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("auto")}>
              {saving === "auto" ? (isThai ? "กำลังตั้งคิว..." : "Scheduling...") : copy.saveAuto}
            </button>
            <button className="button" type="button" disabled={saving !== null} onClick={() => handleAction("instant")}>
              {saving === "instant" ? (isThai ? "กำลังโพสต์..." : "Posting...") : copy.postNow}
            </button>
          </div>
        </div>

        <div className="composer-summary-grid composer-summary-grid-fb">
          <div className="summary-pill">
            <span>{copy.selectedPages}</span>
            <strong>{selectedPages.length || 0}</strong>
          </div>
          <div className="summary-pill">
            <span>{copy.selectedImages}</span>
            <strong>{selectedImageNames.length || 0}</strong>
          </div>
          <div className="summary-pill">
            <span>{copy.postingStatus}</span>
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

      <div className="composer-facebook-layout">
        <div className="composer-facebook-main stack">
          <section className="card composer-facebook-card stack">
            <div className="composer-facebook-head">
              <div className="composer-page-avatar">{primaryPageName.slice(0, 1).toUpperCase()}</div>
              <div className="composer-page-meta">
                <strong>{primaryPageName}</strong>
                <div className="composer-audience-row">
                  <span className="audience-pill active">{copy.audiencePublic}</span>
                  <span className="audience-pill">{copy.audienceFollowers}</span>
                  <span className="audience-pill">{copy.audienceTeam}</span>
                </div>
              </div>
            </div>

            <div className="form">
              <label className="label">
                {copy.postTitleHint}
                <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("composePostTitlePlaceholder")} required />
                <span className="label-hint">{copy.titleOptional}</span>
              </label>

              <label className="label composer-facebook-textwrap">
                <span>{copy.contentTitle}</span>
                <textarea
                  className="textarea composer-facebook-textarea"
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder={`${copy.fbPrompt} ${primaryPageName}?`}
                  required
                />
              </label>

              <label className="label">
                {t("composeHashtags")}
                <input className="input" value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} placeholder={t("composeHashtagsPlaceholder")} />
              </label>
            </div>

            <div className="composer-media-box stack">
              <div className="section-head compact-head">
                <div>
                  <h3>{copy.addToPost}</h3>
                </div>
              </div>

              <div className="composer-upload-actions">
                <button className="button-secondary" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  {uploading ? copy.uploadingMedia : copy.uploadFromDevice}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={handleUploadFiles}
                />
              </div>

              <div className="toggle-grid composer-post-tools">
                <label className="list-item">
                  <span>{copy.imageMode}</span>
                  <input type="checkbox" checked={form.randomizeImages} onChange={(e) => setForm({ ...form, randomizeImages: e.target.checked })} />
                </label>
                <label className="list-item">
                  <span>{copy.captionMode}</span>
                  <input type="checkbox" checked={form.randomizeCaption} onChange={(e) => setForm({ ...form, randomizeCaption: e.target.checked })} />
                </label>
              </div>

              <div className="composer-media-preview-grid">
                {selectedImageNames.length > 0 ? (
                  selectedImageNames.map((name) => (
                    <div key={name} className="composer-media-preview-item">
                      <div className="composer-media-preview-thumb">IMG</div>
                      <span>{name}</span>
                    </div>
                  ))
                ) : (
                  <div className="composer-media-empty">{copy.mediaEmpty}</div>
                )}
              </div>
            </div>
          </section>

          <section className="card stack">
            <div className="section-head">
              <div>
                <h2>{copy.aiTitle}</h2>
                <p className="section-copy">{copy.variantsHint}</p>
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
        </div>

        <aside className="composer-facebook-side stack">
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

              <label className="label">
                {copy.chooseDriveFolder}
                <select className="select" value={form.selectedDriveFolderId} onChange={(e) => setForm({ ...form, selectedDriveFolderId: e.target.value })}>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>{folder.id === "root" ? (isThai ? "ไดรฟ์ของฉัน" : "My Drive") : folder.name}</option>
                  ))}
                </select>
                <span className="label-hint">{copy.imagePoolHint}</span>
              </label>

              <button className="button-secondary" type="button" onClick={useDriveFolderAsImagePool} disabled={folderImages.length === 0}>
                {copy.syncFolderImages}
              </button>

              <div className="label">
                <span>{copy.drivePool}</span>
                <div className="chip-grid">
                  {allImageOptions.map((image) => {
                    const active = form.imageUrls.includes(image.ref);
                    return (
                      <button key={image.ref} type="button" className={`choice-chip ${active ? "active" : ""}`} onClick={() => toggleMultiValue(image.ref, form.imageUrls, "imageUrls")}>
                        {image.name}
                      </button>
                    );
                  })}
                  {allImageOptions.length === 0 ? <div className="muted">{copy.noSelection}</div> : null}
                </div>
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

          <section className="card stack">
            <div className="section-head">
              <div>
                <h2>{copy.fbPreview}</h2>
              </div>
            </div>

            <article className="fb-preview-card">
              <div className="fb-preview-head">
                <div className="composer-page-avatar small">{primaryPageName.slice(0, 1).toUpperCase()}</div>
                <div>
                  <strong>{primaryPageName}</strong>
                  <p>{copy.audiencePublic}</p>
                </div>
              </div>

              <div className="fb-preview-body">
                {previewCaption || <span className="muted">{copy.fbPrompt}...</span>}
              </div>

              {selectedImageNames.length > 0 ? (
                <div className="fb-preview-media-grid">
                  {selectedImageNames.slice(0, 4).map((name) => (
                    <div key={name} className="fb-preview-media-item">{name}</div>
                  ))}
                </div>
              ) : null}

              <div className="fb-preview-actions">
                <span>{copy.like}</span>
                <span>{copy.comment}</span>
                <span>{copy.share}</span>
              </div>
            </article>
          </section>
        </aside>
      </div>
    </form>
  );
}
