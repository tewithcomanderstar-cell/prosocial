"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type SetupWizardStepKey =
  | "facebook"
  | "pages"
  | "drive"
  | "persona"
  | "first-post"
  | "dry-run"
  | "automation";

type SetupWizardResponse = {
  ok: boolean;
  message?: string;
  data?: {
    session: {
      status: "not_started" | "in_progress" | "completed";
      currentStep: SetupWizardStepKey;
      progressPercent: number;
      completedCount: number;
      totalSteps: number;
      resumable: boolean;
      lastVisitedAt?: string;
    };
    steps: Array<{
      key: SetupWizardStepKey;
      label: string;
      status: "pending" | "loading" | "success" | "error";
      title: string;
      message: string;
      rootCause: string;
      fixAction?: {
        label: string;
        href?: string;
        actionKey?: string;
      };
    }>;
    resources: {
      user: {
        id: string;
        name: string;
        email: string;
        timezone: string;
        locale: string;
      } | null;
      system: {
        readyCount: number;
        totalCount: number;
      };
      facebookPages: Array<{
        pageId: string;
        name: string;
        category?: string;
      }>;
      selectedPageIds: string[];
      driveFolders: Array<{
        id: string;
        name: string;
      }>;
      selectedFolderId: string;
      selectedFolderName: string;
      personas: Array<{
        pageId: string;
        pageName?: string;
        tone?: string;
        contentStyle?: string;
        audience?: string;
        promptNotes?: string;
      }>;
      firstPost: {
        title: string;
        content: string;
        hashtags?: string[];
      } | null;
      autoPostConfig: {
        enabled: boolean;
        folderId?: string;
        folderName?: string;
        targetPageIds: string[];
        intervalMinutes?: number;
      } | null;
      draftDryRun?: {
        passed?: boolean;
        summary?: string;
      } | null;
    };
  };
};

const STEP_ORDER: SetupWizardStepKey[] = [
  "facebook",
  "pages",
  "drive",
  "persona",
  "first-post",
  "dry-run",
  "automation"
];

function badgeClass(status: "pending" | "loading" | "success" | "error") {
  if (status === "success") return "badge badge-success";
  if (status === "error") return "badge badge-warn";
  if (status === "loading") return "badge badge-info";
  return "badge badge-neutral";
}

function badgeLabel(status: "pending" | "loading" | "success" | "error") {
  if (status === "success") return "Ready";
  if (status === "error") return "Needs fix";
  if (status === "loading") return "Loading";
  return "Waiting";
}

export function SetupWizard() {
  const [wizard, setWizard] = useState<SetupWizardResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [activeStep, setActiveStep] = useState<SetupWizardStepKey>("facebook");
  const [savingStep, setSavingStep] = useState<SetupWizardStepKey | null>(null);

  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState("root");
  const [personaPageId, setPersonaPageId] = useState("");
  const [personaTone, setPersonaTone] = useState("warm and trustworthy");
  const [personaStyle, setPersonaStyle] = useState("educational sales");
  const [personaAudience, setPersonaAudience] = useState("Thai social media shoppers");
  const [personaNotes, setPersonaNotes] = useState("");
  const [postTitle, setPostTitle] = useState("First automated post");
  const [postContent, setPostContent] = useState("");
  const [postHashtags, setPostHashtags] = useState("");

  async function loadWizard() {
    setLoading(true);
    const response = await fetch("/api/setup/session", {
      cache: "no-store",
      credentials: "include"
    });
    const result: SetupWizardResponse = await response.json();
    setLoading(false);

    if (!result.ok || !result.data) {
      setMessage(result.message || "Unable to load setup wizard.");
      return;
    }

    setWizard(result.data);
    setActiveStep(result.data.session.currentStep);
    setSelectedPageIds(result.data.resources.selectedPageIds);
    setSelectedFolderId(result.data.resources.selectedFolderId || "root");

    const primaryPageId =
      result.data.resources.selectedPageIds[0] ||
      result.data.resources.facebookPages[0]?.pageId ||
      "";
    const existingPersona = result.data.resources.personas.find((item) => item.pageId === primaryPageId);
    setPersonaPageId(primaryPageId);
    setPersonaTone(existingPersona?.tone || "warm and trustworthy");
    setPersonaStyle(existingPersona?.contentStyle || "educational sales");
    setPersonaAudience(existingPersona?.audience || "Thai social media shoppers");
    setPersonaNotes(existingPersona?.promptNotes || "");

    setPostTitle(result.data.resources.firstPost?.title || "First automated post");
    setPostContent(result.data.resources.firstPost?.content || "");
    setPostHashtags((result.data.resources.firstPost?.hashtags || []).join(" "));
    setMessage("");
  }

  useEffect(() => {
    loadWizard();
  }, []);

  const stepMap = useMemo(() => {
    const map = new Map<SetupWizardStepKey, NonNullable<SetupWizardResponse["data"]>["steps"][number]>();
    wizard?.steps.forEach((step) => map.set(step.key, step));
    return map;
  }, [wizard]);

  async function startWizard() {
    setLoading(true);
    const response = await fetch("/api/setup/session", {
      method: "POST",
      credentials: "include"
    });
    const result: SetupWizardResponse = await response.json();
    setLoading(false);

    if (!result.ok || !result.data) {
      setMessage(result.message || "Unable to start setup wizard.");
      return;
    }

    setWizard(result.data);
    setActiveStep(result.data.session.currentStep);
    setMessage(result.message || "Setup wizard started.");
  }

  async function submitStep(step: SetupWizardStepKey, payload: Record<string, unknown> = {}) {
    setSavingStep(step);
    setMessage("");

    const response = await fetch(`/api/setup/steps/${step}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result: SetupWizardResponse = await response.json();
    setSavingStep(null);

    if (!result.ok || !result.data) {
      setMessage(result.message || `Unable to save the ${step} step.`);
      await loadWizard();
      return;
    }

    setWizard(result.data);
    setActiveStep(result.data.session.currentStep);
    setMessage(result.message || `${step} saved.`);
  }

  if (loading) {
    return <p className="muted">Loading setup wizard...</p>;
  }

  if (!wizard) {
    return (
      <div className="stack">
        <p className="muted">{message || "Setup wizard is unavailable right now."}</p>
        <button className="button" type="button" onClick={loadWizard}>
          Retry
        </button>
      </div>
    );
  }

  const selectedFolderName =
    wizard.resources.driveFolders.find((folder) => folder.id === selectedFolderId)?.name ||
    wizard.resources.selectedFolderName ||
    "My Drive";

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="split" style={{ alignItems: "center", marginBottom: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <strong>Setup progress</strong>
            <span className="muted">
              {wizard.session.completedCount} / {wizard.session.totalSteps} steps complete
            </span>
          </div>
          <span className={wizard.session.status === "completed" ? "badge badge-success" : "badge badge-info"}>
            {wizard.session.status === "completed"
              ? "Automation ready"
              : wizard.session.resumable
                ? "Resume available"
                : "Not started"}
          </span>
        </div>

        <div
          style={{
            width: "100%",
            height: 12,
            borderRadius: 999,
            overflow: "hidden",
            background: "rgba(255,255,255,0.68)",
            border: "1px solid rgba(255,255,255,0.76)"
          }}
        >
          <div
            style={{
              width: `${wizard.session.progressPercent}%`,
              height: "100%",
              borderRadius: 999,
              background: "linear-gradient(180deg, #3f86ff 0%, #2b6fff 100%)",
              transition: "width 180ms ease"
            }}
          />
        </div>

        <div className="split" style={{ marginTop: 14, alignItems: "center" }}>
          <span className="muted">
            {wizard.session.status === "not_started"
              ? "Start the guided setup and we will save your progress automatically."
              : `Current step: ${stepMap.get(wizard.session.currentStep)?.label || wizard.session.currentStep}`}
          </span>
          {wizard.session.status === "not_started" ? (
            <button className="button" type="button" onClick={startWizard}>
              Start setup
            </button>
          ) : (
            <button className="button-secondary" type="button" onClick={loadWizard}>
              Refresh
            </button>
          )}
        </div>
      </div>

      {message ? <div className="composer-message">{message}</div> : null}

      <div className="grid cols-2">
        {STEP_ORDER.map((stepKey) => {
          const step = stepMap.get(stepKey);
          if (!step) return null;
          const isCurrent = wizard.session.currentStep === step.key;
          const isSaving = savingStep === step.key;

          return (
            <section
              key={step.key}
              className="card"
              style={{
                padding: 18,
                borderColor: isCurrent ? "rgba(43,111,255,0.3)" : undefined,
                boxShadow: isCurrent ? "0 12px 28px rgba(43,111,255,0.14)" : undefined
              }}
            >
              <div className="split" style={{ marginBottom: 12 }}>
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kicker">Step {STEP_ORDER.indexOf(step.key) + 1}</span>
                  <h3>{step.label}</h3>
                </div>
                <span className={badgeClass(step.status)}>{badgeLabel(step.status)}</span>
              </div>

              <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
                <strong>{step.title}</strong>
                <span className="muted">{step.message}</span>
                {step.rootCause ? <span className="muted">Root cause: {step.rootCause}</span> : null}
              </div>

              {step.fixAction?.href ? (
                <Link className="button-secondary" href={step.fixAction.href} style={{ marginBottom: 12 }}>
                  {step.fixAction.label}
                </Link>
              ) : null}

              {step.key === "facebook" ? (
                <div className="stack">
                  <button
                    className="button"
                    type="button"
                    disabled={isSaving}
                    onClick={() => submitStep("facebook")}
                  >
                    {isSaving ? "Checking..." : "Validate Facebook connection"}
                  </button>
                </div>
              ) : null}

              {step.key === "pages" ? (
                <div className="stack">
                  <div className="list">
                    {wizard.resources.facebookPages.length === 0 ? (
                      <div className="list-item">No pages loaded yet. Validate Facebook first.</div>
                    ) : (
                      wizard.resources.facebookPages.map((page) => {
                        const checked = selectedPageIds.includes(page.pageId);
                        return (
                          <label key={page.pageId} className="list-item" style={{ cursor: "pointer" }}>
                            <div className="stack" style={{ gap: 2 }}>
                              <strong>{page.name}</strong>
                              <span className="muted">{page.category || "Facebook page"}</span>
                            </div>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedPageIds((current) =>
                                  event.target.checked
                                    ? [...current, page.pageId]
                                    : current.filter((value) => value !== page.pageId)
                                );
                              }}
                            />
                          </label>
                        );
                      })
                    )}
                  </div>
                  <button
                    className="button"
                    type="button"
                    disabled={isSaving || selectedPageIds.length === 0}
                    onClick={() => submitStep("pages", { targetPageIds: selectedPageIds })}
                  >
                    {isSaving ? "Saving..." : "Save selected pages"}
                  </button>
                </div>
              ) : null}

              {step.key === "drive" ? (
                <div className="stack">
                  <label className="label">
                    Google Drive folder
                    <select
                      className="select"
                      value={selectedFolderId}
                      onChange={(event) => setSelectedFolderId(event.target.value)}
                    >
                      {wizard.resources.driveFolders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button"
                    type="button"
                    disabled={isSaving || wizard.resources.driveFolders.length === 0}
                    onClick={() =>
                      submitStep("drive", {
                        folderId: selectedFolderId,
                        folderName: selectedFolderName
                      })
                    }
                  >
                    {isSaving ? "Saving..." : "Save Drive folder"}
                  </button>
                </div>
              ) : null}

              {step.key === "persona" ? (
                <div className="form">
                  <label className="label">
                    Page
                    <select
                      className="select"
                      value={personaPageId}
                      onChange={(event) => setPersonaPageId(event.target.value)}
                    >
                      <option value="">Select a page</option>
                      {wizard.resources.facebookPages
                        .filter((page) => selectedPageIds.includes(page.pageId))
                        .map((page) => (
                          <option key={page.pageId} value={page.pageId}>
                            {page.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="label">
                    Tone
                    <input className="input" value={personaTone} onChange={(event) => setPersonaTone(event.target.value)} />
                  </label>
                  <label className="label">
                    Writing style
                    <input className="input" value={personaStyle} onChange={(event) => setPersonaStyle(event.target.value)} />
                  </label>
                  <label className="label">
                    Audience
                    <input className="input" value={personaAudience} onChange={(event) => setPersonaAudience(event.target.value)} />
                  </label>
                  <label className="label">
                    Prompt notes
                    <textarea className="textarea" value={personaNotes} onChange={(event) => setPersonaNotes(event.target.value)} />
                  </label>
                  <button
                    className="button"
                    type="button"
                    disabled={isSaving || !personaPageId}
                    onClick={() => {
                      const page = wizard.resources.facebookPages.find((item) => item.pageId === personaPageId);
                      submitStep("persona", {
                        pageId: personaPageId,
                        pageName: page?.name,
                        tone: personaTone,
                        contentStyle: personaStyle,
                        audience: personaAudience,
                        promptNotes: personaNotes
                      });
                    }}
                  >
                    {isSaving ? "Saving..." : "Save persona"}
                  </button>
                </div>
              ) : null}

              {step.key === "first-post" ? (
                <div className="form">
                  <label className="label">
                    Title
                    <input className="input" value={postTitle} onChange={(event) => setPostTitle(event.target.value)} />
                  </label>
                  <label className="label">
                    Content
                    <textarea className="textarea" value={postContent} onChange={(event) => setPostContent(event.target.value)} />
                  </label>
                  <label className="label">
                    Hashtags
                    <input
                      className="input"
                      value={postHashtags}
                      onChange={(event) => setPostHashtags(event.target.value)}
                      placeholder="#brand #launch"
                    />
                  </label>
                  <button
                    className="button"
                    type="button"
                    disabled={isSaving || !postTitle.trim() || !postContent.trim()}
                    onClick={() =>
                      submitStep("first-post", {
                        title: postTitle,
                        content: postContent,
                        hashtags: postHashtags.split(/\s+/).map((value) => value.trim()).filter(Boolean)
                      })
                    }
                  >
                    {isSaving ? "Saving..." : "Create first post"}
                  </button>
                </div>
              ) : null}

              {step.key === "dry-run" ? (
                <div className="stack">
                  {wizard.resources.draftDryRun?.summary ? (
                    <div className="composer-message">{wizard.resources.draftDryRun.summary}</div>
                  ) : null}
                  <button
                    className="button"
                    type="button"
                    disabled={isSaving}
                    onClick={() => submitStep("dry-run")}
                  >
                    {isSaving ? "Testing..." : "Run dry-run"}
                  </button>
                </div>
              ) : null}

              {step.key === "automation" ? (
                <div className="stack">
                  <div className="list-item">
                    <span>Auto Post status</span>
                    <span className={wizard.resources.autoPostConfig?.enabled ? "badge badge-success" : "badge badge-neutral"}>
                      {wizard.resources.autoPostConfig?.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <button
                    className="button"
                    type="button"
                    disabled={isSaving}
                    onClick={() => submitStep("automation", { enabled: true })}
                  >
                    {isSaving ? "Saving..." : "Enable automation"}
                  </button>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
