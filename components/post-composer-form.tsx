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
      aiTitle: isThai ? "AI \u0e0a\u0e48\u0e27\u0e22\u0e40\u0e02\u0e35\u0e22\u0e19\u0e42\u0e1e\u0e2a\u0e15\u0e4c" : "AI assistant",
      contentTitle: isThai ? "\u0e15\u0e31\u0e27\u0e40\u0e02\u0e35\u0e22\u0e19\u0e42\u0e1e\u0e2a\u0e15\u0e4c" : "Post composer",
      targetTitle: isThai ? "\u0e1b\u0e25\u0e32\u0e22\u0e17\u0e32\u0e07\u0e41\u0e25\u0e30\u0e2a\u0e37\u0e48\u0e2d" : "Destinations and media",
      deliveryTitle: isThai ? "\u0e01\u0e32\u0e23\u0e40\u0e1c\u0e22\u0e41\u0e1e\u0e23\u0e48" : "Publishing",
      queueTitle: isThai ? "\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e42\u0e1e\u0e2a\u0e15\u0e4c" : "Ready to post",
      selectedPages: isThai ? "\u0e40\u0e1e\u0e08" : "Pages",
      selectedImages: isThai ? "\u0e23\u0e39\u0e1b" : "Images",
      noSelection: isThai ? "\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49\u0e40\u0e25\u0e37\u0e2d\u0e01" : "Not selected",
      noVariants: isThai ? "\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e21\u0e35\u0e15\u0e31\u0e27\u0e40\u0e25\u0e37\u0e2d\u0e01" : "No variants yet",
      useVariant: isThai ? "\u0e43\u0e0a\u0e49\u0e15\u0e31\u0e27\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e19\u0e35\u0e49" : "Use this",
      saveDraft: isThai ? "\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01\u0e23\u0e48\u0e32\u0e07" : "Save draft",
      postNow: isThai ? "\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e17\u0e31\u0e19\u0e17\u0e35" : "Post now",
      saveAuto: isThai ? "\u0e15\u0e31\u0e49\u0e07\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e2d\u0e31\u0e15\u0e42\u0e19\u0e21\u0e31\u0e15\u0e34" : "Enable auto post",
      postingModeTitle: isThai ? "\u0e23\u0e39\u0e1b\u0e41\u0e1a\u0e1a\u0e01\u0e32\u0e23\u0e01\u0e23\u0e30\u0e08\u0e32\u0e22\u0e42\u0e1e\u0e2a\u0e15\u0e4c" : "Distribution mode",
      quickSchedule: isThai ? "\u0e15\u0e31\u0e49\u0e07\u0e40\u0e27\u0e25\u0e32\u0e40\u0e23\u0e47\u0e27" : "Quick schedule",
      quickHour1: isThai ? "\u0e17\u0e38\u0e01 1 \u0e0a\u0e21." : "Every 1h",
      quickHour2: isThai ? "\u0e17\u0e38\u0e01 2 \u0e0a\u0e21." : "Every 2h",
      quickHour3: isThai ? "\u0e17\u0e38\u0e01 3 \u0e0a\u0e21." : "Every 3h",
      chooseTime: isThai ? "\u0e01\u0e33\u0e2b\u0e19\u0e14\u0e40\u0e27\u0e25\u0e32\u0e40\u0e2d\u0e07" : "Schedule manually",
      startAfterDelay: isThai ? "\u0e40\u0e23\u0e34\u0e48\u0e21\u0e2b\u0e25\u0e31\u0e07\u0e2b\u0e19\u0e48\u0e27\u0e07\u0e40\u0e27\u0e25\u0e32" : "Start after delay",
      delayLabel: isThai ? "\u0e2b\u0e19\u0e48\u0e27\u0e07\u0e40\u0e27\u0e25\u0e32 (\u0e19\u0e32\u0e17\u0e35)" : "Delay (minutes)",
      hourlyLabel: isThai ? "\u0e17\u0e38\u0e01\u0e01\u0e35\u0e48\u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07" : "Every how many hours",
      usePersona: isThai ? "\u0e43\u0e0a\u0e49 persona \u0e02\u0e2d\u0e07\u0e40\u0e1e\u0e08" : "Use page persona",
      noPersona: isThai ? "\u0e44\u0e21\u0e48\u0e40\u0e25\u0e37\u0e2d\u0e01 persona" : "No persona",
      broadcast: isThai ? "\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e40\u0e14\u0e35\u0e22\u0e27\u0e25\u0e07\u0e2b\u0e25\u0e32\u0e22\u0e40\u0e1e\u0e08" : "1 post to many pages",
      randomPages: isThai ? "\u0e2a\u0e38\u0e48\u0e21\u0e40\u0e1e\u0e08\u0e1b\u0e25\u0e32\u0e22\u0e17\u0e32\u0e07" : "Random target page",
      imageMode: isThai ? "\u0e2a\u0e38\u0e48\u0e21\u0e23\u0e39\u0e1b" : "Random images",
      captionMode: isThai ? "\u0e2a\u0e38\u0e48\u0e21\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21" : "Random captions",
      autoSummary: isThai ? "\u0e2d\u0e31\u0e15\u0e42\u0e19\u0e21\u0e31\u0e15\u0e34" : "Automated",
      instantSummary: isThai ? "\u0e17\u0e31\u0e19\u0e17\u0e35" : "Instant",
      selectPagesHint: isThai ? "\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e40\u0e1e\u0e08\u0e17\u0e35\u0e48\u0e08\u0e30\u0e25\u0e07\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e41\u0e1a\u0e1a\u0e40\u0e14\u0e35\u0e22\u0e27\u0e01\u0e31\u0e1a\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e1b\u0e25\u0e32\u0e22\u0e17\u0e32\u0e07\u0e43\u0e19 Facebook Business" : "Choose the pages you want to publish to.",
      selectImagesHint: isThai ? "\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e23\u0e39\u0e1b\u0e17\u0e35\u0e48\u0e15\u0e49\u0e2d\u0e07\u0e01\u0e32\u0e23\u0e43\u0e0a\u0e49\u0e43\u0e19\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e19\u0e35\u0e49" : "Choose the media for this post.",
      publishAudience: isThai ? "\u0e1c\u0e39\u0e49\u0e0a\u0e21" : "Audience",
      audiencePublic: isThai ? "\u0e2a\u0e32\u0e18\u0e32\u0e23\u0e13\u0e30" : "Public",
      audienceFollowers: isThai ? "\u0e1c\u0e39\u0e49\u0e15\u0e34\u0e14\u0e15\u0e32\u0e21" : "Followers",
      audienceTeam: isThai ? "\u0e17\u0e35\u0e21\u0e07\u0e32\u0e19" : "Team only",
      fbPrompt: isThai ? "\u0e04\u0e38\u0e13\u0e01\u0e33\u0e25\u0e31\u0e07\u0e04\u0e34\u0e14\u0e2d\u0e30\u0e44\u0e23\u0e2d\u0e22\u0e39\u0e48" : "What is on your mind?",
      addToPost: isThai ? "\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e43\u0e19\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e02\u0e2d\u0e07\u0e04\u0e38\u0e13" : "Add to your post",
      fbPreview: isThai ? "\u0e15\u0e31\u0e27\u0e2d\u0e22\u0e48\u0e32\u0e07\u0e41\u0e1a\u0e1a Facebook" : "Facebook preview",
      postSettings: isThai ? "\u0e15\u0e31\u0e49\u0e07\u0e04\u0e48\u0e32\u0e42\u0e1e\u0e2a\u0e15\u0e4c" : "Post settings",
      primaryPage: isThai ? "\u0e40\u0e1e\u0e08\u0e2b\u0e25\u0e31\u0e01" : "Primary page",
      postTitleHint: isThai ? "\u0e2b\u0e31\u0e27\u0e02\u0e49\u0e2d\u0e20\u0e32\u0e22\u0e43\u0e19\u0e23\u0e30\u0e1a\u0e1a" : "Internal title",
      titleOptional: isThai ? "\u0e43\u0e0a\u0e49\u0e08\u0e31\u0e14\u0e01\u0e32\u0e23\u0e04\u0e34\u0e27\u0e20\u0e32\u0e22\u0e43\u0e19 \u0e44\u0e21\u0e48\u0e41\u0e2a\u0e14\u0e07\u0e43\u0e19 Facebook" : "For your internal queue only.",
      variantsHint: isThai ? "\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e2a\u0e44\u0e15\u0e25\u0e4c\u0e17\u0e35\u0e48 AI \u0e2a\u0e23\u0e49\u0e32\u0e07\u0e41\u0e25\u0e49\u0e27\u0e14\u0e36\u0e07\u0e21\u0e32\u0e43\u0e2a\u0e48\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e14\u0e49\u0e32\u0e19\u0e0b\u0e49\u0e32\u0e22\u0e44\u0e14\u0e49\u0e17\u0e31\u0e19\u0e17\u0e35" : "Pick an AI variant and apply it to the post instantly.",
      postingStatus: isThai ? "\u0e2a\u0e16\u0e32\u0e19\u0e30\u0e01\u0e32\u0e23\u0e40\u0e1c\u0e22\u0e41\u0e1e\u0e23\u0e48" : "Publishing status",
      mediaEmpty: isThai ? "\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e23\u0e39\u0e1b \u0e23\u0e30\u0e1a\u0e1a\u0e08\u0e30\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e41\u0e1a\u0e1a\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21\u0e2b\u0e23\u0e37\u0e2d\u0e43\u0e0a\u0e49\u0e04\u0e48\u0e32\u0e40\u0e23\u0e34\u0e48\u0e21\u0e15\u0e49\u0e19\u0e15\u0e32\u0e21 flow" : "No media selected yet.",
      like: isThai ? "\u0e16\u0e39\u0e01\u0e43\u0e08" : "Like",
      comment: isThai ? "\u0e41\u0e2a\u0e14\u0e07\u0e04\u0e27\u0e32\u0e21\u0e04\u0e34\u0e14\u0e40\u0e2b\u0e47\u0e19" : "Comment",
      share: isThai ? "\u0e41\u0e0a\u0e23\u0e4c" : "Share",
      atAGlance: isThai ? "\u0e20\u0e32\u0e1e\u0e23\u0e27\u0e21" : "At a glance"
    }),
    [isThai]
  );

  const selectedPages = useMemo(
    () => pages.filter((page) => form.targetPageIds.includes(page.pageId)),
    [pages, form.targetPageIds]
  );

  const selectedImageNames = useMemo(
    () => images.filter((image) => form.imageUrls.includes(`drive:${image.id}`)).map((image) => image.name),
    [images, form.imageUrls]
  );

  const previewCaption = useMemo(() => {
    const hashtagText = form.hashtags.trim();
    return [form.content.trim(), hashtagText].filter(Boolean).join("\n\n");
  }, [form.content, form.hashtags]);

  const primaryPageName = selectedPages[0]?.name || (isThai ? "\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e40\u0e1e\u0e08\u0e2d\u0e22\u0e48\u0e32\u0e07\u0e19\u0e49\u0e2d\u0e22 1 \u0e40\u0e1e\u0e08" : "Choose at least one page");

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
      setMessage(isThai ? "\u0e01\u0e23\u0e2d\u0e01\u0e0a\u0e37\u0e48\u0e2d\u0e42\u0e1e\u0e2a\u0e15\u0e4c \u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21 \u0e41\u0e25\u0e30\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e40\u0e1e\u0e08\u0e2d\u0e22\u0e48\u0e32\u0e07\u0e19\u0e49\u0e2d\u0e22 1 \u0e40\u0e1e\u0e08\u0e01\u0e48\u0e2d\u0e19" : "Please enter a title, content, and choose at least one target page.");
      return;
    }

    if (mode === "auto" && form.startMode === "scheduled" && !form.runAt) {
      setMessage(isThai ? "\u0e01\u0e23\u0e38\u0e13\u0e32\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e40\u0e27\u0e25\u0e32\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e42\u0e2b\u0e21\u0e14\u0e2d\u0e31\u0e15\u0e42\u0e19\u0e21\u0e31\u0e15\u0e34" : "Please choose the posting time for auto mode.");
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
          </div>
          <div className="composer-actions">
            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("draft")}>
              {saving === "draft" ? (isThai ? "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01..." : "Saving...") : copy.saveDraft}
            </button>
            <button className="button-secondary" type="button" disabled={saving !== null} onClick={() => handleAction("auto")}>
              {saving === "auto" ? (isThai ? "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e15\u0e31\u0e49\u0e07\u0e04\u0e34\u0e27..." : "Scheduling...") : copy.saveAuto}
            </button>
            <button className="button" type="button" disabled={saving !== null} onClick={() => handleAction("instant")}>
              {saving === "instant" ? (isThai ? "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e42\u0e1e\u0e2a\u0e15\u0e4c..." : "Posting...") : copy.postNow}
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
                ? `${form.intervalHours}${isThai ? " \u0e0a\u0e21." : "h"}`
                : form.frequency === "daily"
                  ? (isThai ? "\u0e23\u0e32\u0e22\u0e27\u0e31\u0e19" : "Daily")
                  : form.frequency === "weekly"
                    ? (isThai ? "\u0e23\u0e32\u0e22\u0e2a\u0e31\u0e1b\u0e14\u0e32\u0e2b\u0e4c" : "Weekly")
                    : (isThai ? "\u0e04\u0e23\u0e31\u0e49\u0e07\u0e40\u0e14\u0e35\u0e22\u0e27" : "Once")}
            </strong>
          </div>
          <div className="summary-pill">
            <span>{isThai ? "\u0e42\u0e2b\u0e21\u0e14" : "Mode"}</span>
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
                  <strong>{isThai ? `\u0e15\u0e31\u0e27\u0e40\u0e25\u0e37\u0e2d\u0e01 ${index + 1}` : `Option ${index + 1}`}</strong>
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
                  <span>{form.delayMinutes}{isThai ? " \u0e19\u0e32\u0e17\u0e35" : " min"}</span>
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
                {isThai ? "\u0e23\u0e39\u0e1b\u0e41\u0e1a\u0e1a\u0e01\u0e32\u0e23\u0e42\u0e1e\u0e2a\u0e15\u0e4c\u0e0b\u0e49\u0e33" : "Repeat"}
                <select className="select" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                  <option value="once">{t("scheduleOneTime")}</option>
                  <option value="hourly">{isThai ? "\u0e17\u0e38\u0e01 X \u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07" : "Every X hours"}</option>
                  <option value="daily">{t("scheduleEveryDay")}</option>
                  <option value="weekly">{t("scheduleEveryWeek")}</option>
                </select>
              </label>

              {form.frequency === "hourly" ? (
                <label className="label">
                  {copy.hourlyLabel}
                  <select className="select" value={form.intervalHours} onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) })}>
                    <option value="1">1 {isThai ? "\u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07" : "hour"}</option>
                    <option value="2">2 {isThai ? "\u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07" : "hours"}</option>
                    <option value="3">3 {isThai ? "\u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07" : "hours"}</option>
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
