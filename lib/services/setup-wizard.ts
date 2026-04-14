import { connectDb } from "@/lib/db";
import { getSetupStatus } from "@/lib/setup-status";
import { fetchDriveFolders } from "@/lib/services/google-drive";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { PagePersona } from "@/models/PagePersona";
import { Post } from "@/models/Post";
import { SetupSession } from "@/models/SetupSession";
import { User } from "@/models/User";

export const SETUP_WIZARD_STEPS = [
  "facebook",
  "pages",
  "drive",
  "persona",
  "first-post",
  "dry-run",
  "automation"
] as const;

export type SetupWizardStepKey = (typeof SETUP_WIZARD_STEPS)[number];
type StepStatus = "pending" | "loading" | "success" | "error";

type FixAction = {
  label: string;
  href?: string;
  actionKey?: string;
};

export type SetupWizardStep = {
  key: SetupWizardStepKey;
  label: string;
  status: StepStatus;
  title: string;
  message: string;
  rootCause: string;
  fixAction?: FixAction;
};

type LeanUser = {
  _id: string;
  name: string;
  email: string;
  timezone?: string;
  locale?: string;
};

type LeanAutoPostConfig = {
  _id: string;
  enabled: boolean;
  folderId?: string;
  folderName?: string;
  targetPageIds: string[];
  intervalMinutes?: number;
  captionStrategy?: "manual" | "ai" | "hybrid";
  captions?: string[];
  hashtags?: string[];
  aiPrompt?: string;
  language?: "th" | "en";
  lastError?: string | null;
};

type LeanPersona = {
  _id: string;
  pageId: string;
  pageName?: string;
  timezone?: string;
  locale?: string;
  tone?: string;
  contentStyle?: string;
  audience?: string;
  promptNotes?: string;
  active?: boolean;
};

type LeanPost = {
  _id: string;
  title: string;
  content: string;
  hashtags?: string[];
  imageUrls?: string[];
  targetPageIds?: string[];
  status?: string;
  createdAt?: Date;
};

type LeanSetupSession = {
  _id: string;
  userId: string;
  status: "not_started" | "in_progress" | "completed";
  currentStep: SetupWizardStepKey;
  completedSteps: string[];
  stepData: Record<string, unknown>;
  steps: Array<{
    key: SetupWizardStepKey;
    status: StepStatus;
    title?: string;
    message?: string;
    rootCause?: string;
    fixActionKey?: string;
    fixActionLabel?: string;
    updatedAt?: Date;
  }>;
  lastError?: string;
  startedAt?: Date;
  completedAt?: Date;
  lastVisitedAt?: Date;
};

type FacebookPageResource = {
  pageId: string;
  name: string;
  category?: string;
};

type DriveFolderResource = {
  id: string;
  name: string;
};

type WizardResources = {
  user: {
    id: string;
    name: string;
    email: string;
    timezone: string;
    locale: string;
  } | null;
  system: ReturnType<typeof getSetupStatus>;
  facebookPages: FacebookPageResource[];
  selectedPageIds: string[];
  driveFolders: DriveFolderResource[];
  selectedFolderId: string;
  selectedFolderName: string;
  personas: LeanPersona[];
  firstPost: LeanPost | null;
  autoPostConfig: LeanAutoPostConfig | null;
  draftDryRun?: Record<string, unknown> | null;
};

export type SetupWizardState = {
  session: {
    status: "not_started" | "in_progress" | "completed";
    currentStep: SetupWizardStepKey;
    progressPercent: number;
    completedCount: number;
    totalSteps: number;
    resumable: boolean;
    lastVisitedAt?: string;
  };
  steps: SetupWizardStep[];
  resources: WizardResources;
};

const STEP_LABELS: Record<SetupWizardStepKey, string> = {
  facebook: "Connect Facebook",
  pages: "Select pages",
  drive: "Connect Google Drive",
  persona: "Create persona",
  "first-post": "Create first post",
  "dry-run": "Dry-run test",
  automation: "Enable automation"
};

function defaultStoredSteps() {
  return SETUP_WIZARD_STEPS.map((key) => ({
    key,
    status: "pending" as StepStatus,
    title: "",
    message: "",
    rootCause: "",
    fixActionKey: "",
    fixActionLabel: "",
    updatedAt: new Date()
  }));
}

async function getOrCreateSetupSession(userId: string) {
  return (await SetupSession.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        status: "not_started",
        currentStep: "facebook",
        completedSteps: [],
        stepData: {},
        steps: defaultStoredSteps(),
        startedAt: null,
        completedAt: null,
        lastVisitedAt: new Date()
      }
    },
    { upsert: true, new: true }
  )) as unknown as LeanSetupSession;
}

function asErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function getFixActionForStep(step: SetupWizardStepKey): FixAction | undefined {
  const map: Partial<Record<SetupWizardStepKey, FixAction>> = {
    facebook: { label: "Connect Facebook", href: "/connections/facebook" },
    pages: { label: "Choose pages", href: "/connections/facebook" },
    drive: { label: "Connect Drive", href: "/connections/google-drive" },
    persona: { label: "Edit persona", actionKey: "edit-persona" },
    "first-post": { label: "Draft post", actionKey: "edit-post" },
    "dry-run": { label: "Retry dry-run", actionKey: "retry" },
    automation: { label: "Enable now", actionKey: "enable" }
  };

  return map[step];
}

function createStep(
  key: SetupWizardStepKey,
  status: StepStatus,
  title: string,
  message: string,
  rootCause = "",
  fixAction?: FixAction
): SetupWizardStep {
  return {
    key,
    label: STEP_LABELS[key],
    status,
    title,
    message,
    rootCause,
    fixAction
  };
}

export async function buildSetupWizardState(userId: string): Promise<SetupWizardState> {
  await connectDb();

  const [session, user, config, personas, firstPost] = await Promise.all([
    getOrCreateSetupSession(userId),
    User.findById(userId).lean<LeanUser | null>(),
    AutoPostConfig.findOne({ userId }).lean<LeanAutoPostConfig | null>(),
    PagePersona.find({ userId }).sort({ updatedAt: -1 }).lean<LeanPersona[]>(),
    Post.findOne({ userId }).sort({ createdAt: -1 }).lean<LeanPost | null>()
  ]);

  const system = getSetupStatus();
  const facebookSystemReady = system.items.find((item) => item.key === "facebook")?.ready ?? false;
  const googleSystemReady = system.items.find((item) => item.key === "google")?.ready ?? false;

  let facebookPages: FacebookPageResource[] = [];
  let driveFolders: DriveFolderResource[] = [];
  let facebookError = "";
  let driveError = "";

  if (facebookSystemReady) {
    try {
      const connection = await ensureValidFacebookConnection(userId);
      facebookPages = (connection.pages ?? []).map((page: { pageId: string; name: string; category?: string }) => ({
        pageId: page.pageId,
        name: page.name,
        category: page.category
      }));
    } catch (error) {
      facebookError = asErrorMessage(error, "Facebook connection is not ready yet.");
    }
  } else {
    facebookError = "Facebook OAuth environment variables are still incomplete.";
  }

  if (googleSystemReady) {
    try {
      const connection = await ensureValidGoogleDriveConnection(userId);
      const payload = await fetchDriveFolders(connection.accessToken, "root");
      driveFolders = [{ id: "root", name: "My Drive" }, ...payload.files];
    } catch (error) {
      driveError = asErrorMessage(error, "Google Drive connection is not ready yet.");
    }
  } else {
    driveError = "Google Drive OAuth environment variables are still incomplete.";
  }

  const selectedPageIds = config?.targetPageIds ?? [];
  const selectedPages = facebookPages.filter((page) => selectedPageIds.includes(page.pageId));
  const primaryPage = selectedPages[0] ?? facebookPages[0] ?? null;
  const primaryPersona = primaryPage
    ? personas.find((persona) => persona.pageId === primaryPage.pageId) ?? null
    : null;

  const dryRunData = (session.stepData?.["dry-run"] as Record<string, unknown> | undefined) ?? null;
  const dryRunPassed = dryRunData?.passed === true;

  const steps: SetupWizardStep[] = [];

  if (!facebookError && facebookPages.length > 0) {
    steps.push(
      createStep(
        "facebook",
        "success",
        "Facebook is connected",
        `${facebookPages.length} page${facebookPages.length === 1 ? "" : "s"} found and ready.`
      )
    );
  } else {
    steps.push(
      createStep(
        "facebook",
        facebookSystemReady ? "error" : "pending",
        facebookSystemReady ? "Facebook still needs attention" : "Facebook OAuth is not configured yet",
        facebookError || "Connect Facebook to validate the token and page permissions.",
        facebookError || "A user-level Facebook connection is required before page selection can continue.",
        getFixActionForStep("facebook")
      )
    );
  }

  if (!facebookError && selectedPageIds.length > 0) {
    steps.push(
      createStep(
        "pages",
        "success",
        "Pages selected",
        `${selectedPageIds.length} page${selectedPageIds.length === 1 ? "" : "s"} selected for automation.`
      )
    );
  } else {
    steps.push(
      createStep(
        "pages",
        facebookError ? "pending" : "error",
        facebookError ? "Waiting for Facebook connection" : "Choose at least one page",
        facebookError
          ? "Connect Facebook first so the wizard can load your pages."
          : "Select the Facebook pages that should receive automated posts.",
        facebookError ? "Page selection depends on a healthy Facebook connection." : "No target pages are saved in Auto Post settings yet.",
        getFixActionForStep("pages")
      )
    );
  }

  if (!driveError && config?.folderId) {
    steps.push(
      createStep(
        "drive",
        "success",
        "Google Drive is connected",
        `${config.folderName || "Selected folder"} is ready as the media source.`
      )
    );
  } else {
    steps.push(
      createStep(
        "drive",
        googleSystemReady ? (driveError ? "error" : "pending") : "pending",
        googleSystemReady ? "Connect Google Drive" : "Google Drive OAuth is not configured yet",
        driveError || "Choose the folder that the automation should monitor for media.",
        driveError || "No Drive folder has been saved to Auto Post settings yet.",
        getFixActionForStep("drive")
      )
    );
  }

  if (primaryPersona) {
    steps.push(
      createStep(
        "persona",
        "success",
        "Persona saved",
        `${primaryPersona.pageName || primaryPersona.pageId} uses ${primaryPersona.tone || "custom"} tone and ${primaryPersona.contentStyle || "custom"} style.`
      )
    );
  } else {
    steps.push(
      createStep(
        "persona",
        primaryPage ? "error" : "pending",
        primaryPage ? "Create the first persona" : "Waiting for page selection",
        primaryPage
          ? `Define tone, audience, and style for ${primaryPage.name} before automation starts.`
          : "Select a page first so the wizard knows which persona to create.",
        primaryPage ? "The selected page still has no persona profile." : "Persona creation depends on at least one selected page.",
        getFixActionForStep("persona")
      )
    );
  }

  if (firstPost) {
    steps.push(
      createStep(
        "first-post",
        "success",
        "First post drafted",
        `"${firstPost.title}" is ready as the first content template.`
      )
    );
  } else {
    steps.push(
      createStep(
        "first-post",
        "error",
        "Create the first post",
        "Draft a post so the automation has an approved starting point.",
        "No post draft exists for this workspace yet.",
        getFixActionForStep("first-post")
      )
    );
  }

  if (dryRunPassed) {
    steps.push(
      createStep(
        "dry-run",
        "success",
        "Dry-run passed",
        typeof dryRunData?.summary === "string"
          ? dryRunData.summary
          : "The automation simulation validated connections, content, and destinations."
      )
    );
  } else {
    const prerequisitesReady =
      !facebookError &&
      selectedPageIds.length > 0 &&
      !driveError &&
      Boolean(primaryPersona) &&
      Boolean(firstPost);

    steps.push(
      createStep(
        "dry-run",
        prerequisitesReady ? "error" : "pending",
        prerequisitesReady ? "Run a dry-run before going live" : "Waiting for earlier setup steps",
        prerequisitesReady
          ? "Simulate the first publish to catch missing media, token, or page issues without posting publicly."
          : "Finish Facebook, pages, Drive, persona, and first post before running the dry-run.",
        prerequisitesReady
          ? "The wizard has not run a successful dry-run yet."
          : "Dry-run depends on all upstream setup steps being successful.",
        getFixActionForStep("dry-run")
      )
    );
  }

  if (config?.enabled) {
    steps.push(
      createStep(
        "automation",
        "success",
        "Automation is enabled",
        `${selectedPageIds.length || 0} page${selectedPageIds.length === 1 ? "" : "s"} ready on a ${config.intervalMinutes || 60}-minute cadence.`
      )
    );
  } else {
    steps.push(
      createStep(
        "automation",
        dryRunPassed ? "error" : "pending",
        dryRunPassed ? "Enable automation" : "Waiting for dry-run",
        dryRunPassed
          ? "Turn on Auto Post when you are ready to start the live schedule."
          : "The wizard enables automation only after the dry-run succeeds.",
        dryRunPassed ? "Auto Post is still disabled for this workspace." : "Automation is intentionally blocked until the dry-run passes.",
        getFixActionForStep("automation")
      )
    );
  }

  const completedSteps = steps.filter((step) => step.status === "success").map((step) => step.key);
  const currentStep = steps.find((step) => step.status !== "success")?.key ?? "automation";
  const progressPercent = Math.round((completedSteps.length / SETUP_WIZARD_STEPS.length) * 100);

  session.steps = steps.map((step) => ({
    key: step.key,
    status: step.status,
    title: step.title,
    message: step.message,
    rootCause: step.rootCause,
    fixActionKey: step.fixAction?.actionKey || step.fixAction?.href || "",
    fixActionLabel: step.fixAction?.label || "",
    updatedAt: new Date()
  }));
  session.completedSteps = completedSteps;
  session.currentStep = currentStep;
  session.status = completedSteps.length === SETUP_WIZARD_STEPS.length
    ? "completed"
    : completedSteps.length > 0 || Object.keys(session.stepData || {}).length > 0
      ? "in_progress"
      : "not_started";
  session.completedAt = session.status === "completed" ? session.completedAt ?? new Date() : undefined;
  session.lastVisitedAt = new Date();
  if (session.status !== "not_started" && !session.startedAt) {
    session.startedAt = new Date();
  }
  await SetupSession.findByIdAndUpdate((session as unknown as { _id: string })._id, {
    status: session.status,
    currentStep: session.currentStep,
    completedSteps: session.completedSteps,
    steps: session.steps,
    completedAt: session.completedAt ?? null,
    startedAt: session.startedAt ?? null,
    lastVisitedAt: session.lastVisitedAt
  });

  return {
    session: {
      status: session.status,
      currentStep,
      progressPercent,
      completedCount: completedSteps.length,
      totalSteps: SETUP_WIZARD_STEPS.length,
      resumable: session.status === "in_progress",
      lastVisitedAt: session.lastVisitedAt?.toISOString?.()
    },
    steps,
    resources: {
      user: user
        ? {
            id: String(user._id),
            name: user.name,
            email: user.email,
            timezone: user.timezone || "Asia/Bangkok",
            locale: user.locale || "th-TH"
          }
        : null,
      system,
      facebookPages,
      selectedPageIds,
      driveFolders,
      selectedFolderId: config?.folderId || "root",
      selectedFolderName: config?.folderName || "My Drive",
      personas,
      firstPost,
      autoPostConfig: config,
      draftDryRun: dryRunData
    }
  };
}

export async function startSetupSession(userId: string) {
  await connectDb();
  await SetupSession.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        steps: defaultStoredSteps(),
        stepData: {}
      },
      $set: {
        status: "in_progress",
        startedAt: new Date(),
        lastVisitedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );

  return buildSetupWizardState(userId);
}

export async function updateSetupSessionStepData(userId: string, stepKey: SetupWizardStepKey, payload: Record<string, unknown>) {
  await connectDb();
  await SetupSession.findOneAndUpdate(
    { userId },
    {
      $set: {
        [`stepData.${stepKey}`]: payload,
        status: "in_progress",
        lastVisitedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );
}
