"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/language-provider";

type Page = {
  pageId: string;
  name: string;
};

type UploadedImage = {
  id: string;
  name: string;
  ref: string;
  mimeType?: string;
};

type PreviewImage = UploadedImage & {
  previewUrl: string;
};

type ActionMode = "instant" | "schedule";

function buildInternalTitle(content: string) {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return `Post ${new Date().toISOString()}`;
  }

  return normalized.slice(0, 80);
}

export function PostComposerForm() {
  const { language, t } = useI18n();
  const isThai = language === "th";
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [pages, setPages] = useState<Page[]>([]);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [runAt, setRunAt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState<ActionMode | null>(null);
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<PreviewImage[]>([]);

  useEffect(() => {
    fetch("/api/facebook/pages", { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setPages(result.data.pages);
        }
      });
  }, []);

  useEffect(() => {
    return () => {
      images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    };
  }, [images]);

  const copy = useMemo(
    () => ({
      title: isThai ? "สร้างโพสต์" : "Create Post",
      subtitle: isThai ? "พิมพ์ข้อความ เลือกรูป เลือกเพจ แล้วโพสต์ได้เลย" : "Write your caption, attach media, choose pages, and publish fast.",
      captionLabel: isThai ? "ข้อความโพสต์" : "Caption",
      captionPlaceholder: isThai ? "คุณกำลังคิดอะไรอยู่?" : "What would you like to share?",
      uploadLabel: isThai ? "รูปภาพ" : "Images",
      uploadButton: isThai ? "เลือกรูปจากคอม/มือถือ" : "Choose images from device",
      uploading: isThai ? "กำลังอัปโหลดรูป..." : "Uploading images...",
      emptyImages: isThai ? "ยังไม่ได้เลือกรูป" : "No images selected yet",
      removeImage: isThai ? "ลบรูป" : "Remove image",
      pageLabel: isThai ? "เลือกเพจ" : "Select pages",
      pageHint: isThai ? "เลือกอย่างน้อย 1 เพจสำหรับโพสต์นี้" : "Choose at least one page for this post.",
      noSelection: isThai ? "ยังไม่มีเพจที่เชื่อมไว้" : "No connected pages yet.",
      scheduleLabel: isThai ? "ตั้งเวลาโพสต์" : "Schedule",
      scheduleHint: isThai ? "ถ้าไม่ตั้งเวลา คุณยังโพสต์ทันทีได้" : "Leave blank if you want to post right away.",
      postNow: isThai ? "โพสต์ทันที" : "Post Now",
      schedulePost: isThai ? "Schedule Post" : "Schedule Post",
      posting: isThai ? "กำลังโพสต์..." : "Posting...",
      scheduling: isThai ? "กำลังตั้งเวลา..." : "Scheduling...",
      helper: isThai ? "รองรับหลายรูปและแสดงตัวอย่างทันที" : "Supports multiple images with instant preview.",
      needContent: isThai ? "กรุณากรอกข้อความโพสต์ก่อน" : "Please enter a caption first.",
      needPage: isThai ? "กรุณาเลือกเพจอย่างน้อย 1 เพจ" : "Please choose at least one page.",
      needSchedule: isThai ? "กรุณาเลือกวันและเวลาสำหรับการตั้งเวลาโพสต์" : "Please choose a date and time for scheduling."
    }),
    [isThai]
  );

  function togglePage(pageId: string) {
    setSelectedPageIds((current) =>
      current.includes(pageId) ? current.filter((item) => item !== pageId) : [...current, pageId]
    );
  }

  async function handleUploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    setUploading(true);
    setMessage("");

    const body = new FormData();
    const previews = Array.from(files).map((file) => ({ file, previewUrl: URL.createObjectURL(file) }));
    previews.forEach(({ file }) => body.append("files", file));

    const response = await fetch("/api/media-library/upload", {
      method: "POST",
      body
    });

    const result = await response.json();
    setUploading(false);

    if (!result.ok) {
      previews.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
      setMessage(result.message || t("commonRequestFailed"));
      return;
    }

    const uploads = (result.data.uploads ?? []) as UploadedImage[];
    const nextImages = uploads.map((upload, index) => ({
      ...upload,
      previewUrl: previews[index]?.previewUrl ?? ""
    }));

    setImages((current) => [...current, ...nextImages]);
    event.target.value = "";
  }

  function removeImage(ref: string) {
    setImages((current) => {
      const target = current.find((image) => image.ref === ref);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((image) => image.ref !== ref);
    });
  }

  function buildPayload() {
    return {
      title: buildInternalTitle(content),
      content,
      hashtags: [],
      targetPageIds: selectedPageIds,
      imageUrls: images.map((image) => image.ref),
      randomizeImages: false,
      randomizeCaption: false,
      postingMode: "broadcast",
      variants: []
    };
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

  async function submitSchedule() {
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
        frequency: "once",
        runAt: new Date(runAt).toISOString(),
        timezone: "Asia/Bangkok",
        startMode: "scheduled"
      })
    });

    const scheduleResult = await scheduleResponse.json();
    setMessage(scheduleResult.message || (scheduleResult.ok ? copy.schedulePost : t("commonRequestFailed")));
  }

  async function handleAction(mode: ActionMode) {
    if (!content.trim()) {
      setMessage(copy.needContent);
      return;
    }

    if (selectedPageIds.length === 0) {
      setMessage(copy.needPage);
      return;
    }

    if (mode === "schedule" && !runAt) {
      setMessage(copy.needSchedule);
      return;
    }

    setSaving(mode);
    setMessage("");

    try {
      if (mode === "instant") {
        await submitInstant();
      } else {
        await submitSchedule();
      }
    } finally {
      setSaving(null);
    }
  }

  return (
    <form className="minimal-post-card" onSubmit={(event: FormEvent<HTMLFormElement>) => event.preventDefault()}>
      <div className="minimal-post-head">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
      </div>

      {message ? <div className="composer-message">{message}</div> : null}

      <div className="minimal-post-grid">
        <section className="minimal-post-main stack">
          <label className="label">
            <span>{copy.captionLabel}</span>
            <textarea
              className="textarea minimal-caption-input"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={copy.captionPlaceholder}
              required
            />
          </label>

          <div className="label">
            <span>{copy.uploadLabel}</span>
            <div className="minimal-upload-row">
              <button className="button-secondary" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? copy.uploading : copy.uploadButton}
              </button>
              <span className="label-hint">{copy.helper}</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={handleUploadFiles}
            />
          </div>

          <div className="minimal-image-grid">
            {images.length > 0 ? (
              images.map((image) => (
                <article key={image.ref} className="minimal-image-card">
                  <img src={image.previewUrl} alt={image.name} className="minimal-image-preview" />
                  <div className="minimal-image-meta">
                    <span>{image.name}</span>
                    <button className="minimal-image-remove" type="button" onClick={() => removeImage(image.ref)}>
                      {copy.removeImage}
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <div className="composer-media-empty">{copy.emptyImages}</div>
            )}
          </div>
        </section>

        <aside className="minimal-post-side stack">
          <label className="label">
            <span>{copy.pageLabel}</span>
            <span className="label-hint">{copy.pageHint}</span>
            <div className="chip-grid">
              {pages.map((page) => {
                const active = selectedPageIds.includes(page.pageId);
                return (
                  <button
                    key={page.pageId}
                    type="button"
                    className={`choice-chip ${active ? "active" : ""}`}
                    onClick={() => togglePage(page.pageId)}
                  >
                    {page.name}
                  </button>
                );
              })}
              {pages.length === 0 ? <div className="muted">{copy.noSelection}</div> : null}
            </div>
          </label>

          <label className="label">
            <span>{copy.scheduleLabel}</span>
            <input className="input" type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />
            <span className="label-hint">{copy.scheduleHint}</span>
          </label>

          <div className="minimal-action-stack">
            <button className="button" type="button" disabled={saving !== null} onClick={() => handleAction("instant")}>
              {saving === "instant" ? copy.posting : copy.postNow}
            </button>
            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("schedule")}>
              {saving === "schedule" ? copy.scheduling : copy.schedulePost}
            </button>
          </div>
        </aside>
      </div>
    </form>
  );
}


