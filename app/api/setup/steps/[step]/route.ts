import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { fetchDriveFolders } from "@/lib/services/google-drive";
import { ensureValidFacebookConnection, ensureValidGoogleDriveConnection } from "@/lib/services/integration-auth";
import {
  buildSetupWizardState,
  SETUP_WIZARD_STEPS,
  type SetupWizardStepKey,
  updateSetupSessionStepData
} from "@/lib/services/setup-wizard";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { PagePersona } from "@/models/PagePersona";
import { Post } from "@/models/Post";
import { User } from "@/models/User";

const pageSelectionSchema = z.object({
  targetPageIds: z.array(z.string().min(1)).min(1).max(100)
});

const driveSelectionSchema = z.object({
  folderId: z.string().min(1),
  folderName: z.string().min(1)
});

const personaSchema = z.object({
  pageId: z.string().min(1),
  pageName: z.string().optional(),
  tone: z.string().min(2),
  contentStyle: z.string().min(2),
  audience: z.string().min(2),
  promptNotes: z.string().default("")
});

const postSchema = z.object({
  title: z.string().min(2),
  content: z.string().min(2),
  hashtags: z.array(z.string()).default([])
});

const automationSchema = z.object({
  enabled: z.boolean().default(true)
});

function isStepKey(value: string): value is SetupWizardStepKey {
  return (SETUP_WIZARD_STEPS as readonly string[]).includes(value);
}

async function upsertAutoPostConfig(userId: string, patch: Record<string, unknown>) {
  return AutoPostConfig.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        enabled: false,
        folderId: "root",
        folderName: "My Drive",
        targetPageIds: [],
        intervalMinutes: 60,
        captionStrategy: "hybrid",
        captions: [],
        hashtags: [],
        aiPrompt: "",
        language: "th"
      },
      $set: patch
    },
    { upsert: true, new: true }
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ step: string }> }
) {
  try {
    const userId = await requireAuth();
    const { step: rawStep } = await context.params;

    if (!isStepKey(rawStep)) {
      return jsonError("Unknown setup step", 404);
    }

    const body = await request.json().catch(() => ({}));

    switch (rawStep) {
      case "facebook": {
        const connection = await ensureValidFacebookConnection(userId);
        await updateSetupSessionStepData(userId, "facebook", {
          validatedAt: new Date().toISOString(),
          pageCount: connection.pages?.length ?? 0
        });
        const state = await buildSetupWizardState(userId);
        return jsonOk(state, "Facebook connection verified");
      }

      case "pages": {
        const payload = parseBody(pageSelectionSchema, body);
        const connection = await ensureValidFacebookConnection(userId);
        const availablePageIds = new Set((connection.pages ?? []).map((page: { pageId: string }) => page.pageId));

        for (const pageId of payload.targetPageIds) {
          if (!availablePageIds.has(pageId)) {
            return jsonError(`Page ${pageId} is not available in the current Facebook connection`, 422);
          }
        }

        await upsertAutoPostConfig(userId, { targetPageIds: payload.targetPageIds });
        await updateSetupSessionStepData(userId, "pages", {
          targetPageIds: payload.targetPageIds,
          savedAt: new Date().toISOString()
        });
        const state = await buildSetupWizardState(userId);
        return jsonOk(state, "Pages saved");
      }

      case "drive": {
        const payload = parseBody(driveSelectionSchema, body);
        const connection = await ensureValidGoogleDriveConnection(userId);
        const rootFolders = await fetchDriveFolders(connection.accessToken, "root");
        const allowedFolders = new Map<string, string>([
          ["root", "My Drive"],
          ...rootFolders.files.map((folder): [string, string] => [folder.id, folder.name])
        ]);

        if (!allowedFolders.has(payload.folderId)) {
          return jsonError("Selected folder is no longer available in Google Drive", 422);
        }

        await upsertAutoPostConfig(userId, {
          folderId: payload.folderId,
          folderName: payload.folderName
        });
        await updateSetupSessionStepData(userId, "drive", {
          folderId: payload.folderId,
          folderName: payload.folderName,
          savedAt: new Date().toISOString()
        });
        const state = await buildSetupWizardState(userId);
        return jsonOk(state, "Google Drive folder saved");
      }

      case "persona": {
        const payload = parseBody(personaSchema, body);
        const user = await User.findById(userId).lean<{ timezone?: string; locale?: string } | null>();

        await PagePersona.findOneAndUpdate(
          { userId, pageId: payload.pageId },
          {
            userId,
            pageId: payload.pageId,
            pageName: payload.pageName,
            timezone: user?.timezone || "Asia/Bangkok",
            locale: user?.locale || "th-TH",
            tone: payload.tone,
            contentStyle: payload.contentStyle,
            audience: payload.audience,
            promptNotes: payload.promptNotes,
            active: true
          },
          { upsert: true, new: true }
        );

        await updateSetupSessionStepData(userId, "persona", {
          pageId: payload.pageId,
          savedAt: new Date().toISOString()
        });
        const state = await buildSetupWizardState(userId);
        return jsonOk(state, "Persona saved");
      }

      case "first-post": {
        const payload = parseBody(postSchema, body);
        const config = await AutoPostConfig.findOne({ userId }).lean<{ targetPageIds?: string[] } | null>();
        const targetPageIds = config?.targetPageIds ?? [];

        if (!targetPageIds.length) {
          return jsonError("Select at least one Facebook page before drafting the first post", 422);
        }

        const post = await Post.create({
          userId,
          title: payload.title,
          content: payload.content,
          hashtags: payload.hashtags,
          imageUrls: [],
          targetPageIds,
          postingMode: "broadcast",
          status: "draft"
        });

        await updateSetupSessionStepData(userId, "first-post", {
          postId: String(post._id),
          savedAt: new Date().toISOString()
        });
        const state = await buildSetupWizardState(userId);
        return jsonOk(state, "First post drafted");
      }

      case "dry-run": {
        const [facebookConnection, googleConnection, config, personas, firstPost] = await Promise.all([
          ensureValidFacebookConnection(userId),
          ensureValidGoogleDriveConnection(userId),
          AutoPostConfig.findOne({ userId }).lean<{ folderId?: string; targetPageIds?: string[] } | null>(),
          PagePersona.find({ userId }).lean<Array<{ pageId: string }>>(),
          Post.findOne({ userId }).sort({ createdAt: -1 }).lean<{ _id: string; title: string } | null>()
        ]);

        const missing: string[] = [];
        if (!facebookConnection.pages?.length) missing.push("No Facebook pages are available.");
        if (!(config?.targetPageIds?.length)) missing.push("No Facebook pages are selected.");
        if (!config?.folderId) missing.push("No Google Drive folder is selected.");
        if (!personas.length) missing.push("No persona has been created yet.");
        if (!firstPost) missing.push("No first post draft exists yet.");

        if (missing.length) {
          await updateSetupSessionStepData(userId, "dry-run", {
            passed: false,
            summary: missing.join(" "),
            checkedAt: new Date().toISOString()
          });
          const state = await buildSetupWizardState(userId);
          return jsonError(state.steps.find((step) => step.key === "dry-run")?.message || missing.join(" "), 422);
        }

        const summary = `Dry-run passed for ${config!.targetPageIds?.length ?? 0} page(s) using folder ${config!.folderId} and draft "${firstPost!.title}".`;
        await updateSetupSessionStepData(userId, "dry-run", {
          passed: true,
          summary,
          checkedAt: new Date().toISOString()
        });
        const state = await buildSetupWizardState(userId);
        return jsonOk(state, "Dry-run passed");
      }

      case "automation": {
        const payload = parseBody(automationSchema, body);
        await upsertAutoPostConfig(userId, {
          enabled: payload.enabled,
          autoPostStatus: payload.enabled ? "waiting" : "paused",
          jobStatus: "pending",
          lastError: null
        });
        await updateSetupSessionStepData(userId, "automation", {
          enabled: payload.enabled,
          savedAt: new Date().toISOString()
        });
        const state = await buildSetupWizardState(userId);
        return jsonOk(state, payload.enabled ? "Automation enabled" : "Automation paused");
      }
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update setup step", 400);
  }
}
