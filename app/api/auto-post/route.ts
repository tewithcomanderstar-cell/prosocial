import { z } from "zod";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { logAction } from "@/lib/services/logging";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { DEFAULT_SHOPEE_CATEGORY, normalizeShopeeCategories, normalizeShopeeCategory } from "@/lib/shopee-categories";

type LeanAutoPostConfig = {
  enabled?: boolean;
  nextRunAt?: Date | null;
  autoPostStatus?: "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
  jobStatus?: "pending" | "processing" | "posted" | "failed";
  lastError?: string | null;
  retryCount?: number;
  folderId?: string;
  postingWindowStart?: string | null;
  postingWindowEnd?: string | null;
  postingWindowCustomized?: boolean | null;
  maxPostsPerDay?: number;
  maxPostsPerPagePerDay?: number;
  shopeeCategory?: string | null;
  shopeeCategories?: string[] | null;
};

const intervalSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(120)
]);

const BROKEN_FOLDER_ID = "1sbp9Ql8moMDs9xBSha5IWoKdE1WlEEWz";
const FIXED_FOLDER_ID = "1sbp9Ql8moMDs9xBSha5lWoKdE1WiEEWz";

function normalizeFolderId(value: string) {
  const trimmed = value.trim();
  return trimmed === BROKEN_FOLDER_ID ? FIXED_FOLDER_ID : trimmed;
}

function sanitizeLegacyMessage(value?: string | null) {
  if (!value) return value ?? null;

  const normalized = value.toLowerCase();
  if (
    normalized.includes("n8n") ||
    normalized.includes("requested webhook") ||
    normalized.includes("workflow must be active") ||
    normalized.includes("webhook")
  ) {
    return null;
  }

  return value;
}

function uniquePageIds(pageIds: string[] = []) {
  return Array.from(new Set(pageIds.map((pageId) => pageId.trim()).filter(Boolean)));
}

const schema = z.object({
  enabled: z.boolean(),
  contentSource: z.enum(["shopee-affiliate", "google-drive"]).default("shopee-affiliate"),
  folderId: z.string().min(1).default("root"),
  folderName: z.string().min(1).default("My Drive"),
  shopeeSourceTag: z.enum(["trending", "best_selling", "top_search", "best_roi", "manual"]).default("trending"),
  shopeeKeyword: z.string().default(""),
  shopeeCategory: z.string().default(DEFAULT_SHOPEE_CATEGORY),
  shopeeCategories: z.array(z.string()).default([]),
  shopeeCaptionStyle: z
    .enum(["soft_sell", "urgency", "problem_solution", "review_style", "deal_alert", "lifestyle"])
    .default("soft_sell"),
  shopeeTrackingId: z.string().default(""),
  shopeeBlockedCategories: z.array(z.string()).default([]),
  shopeeCategoryPriority: z.array(z.string()).default([]),
  shopeeMinPrice: z.number().min(0).default(0),
  shopeeMaxPrice: z.number().min(0).default(0),
  shopeeMinRating: z.number().min(0).max(5).default(0),
  shopeeMinSales: z.number().min(0).default(0),
  shopeeMinDiscountPercent: z.number().min(0).max(100).default(0),
  approvalMode: z.boolean().default(false),
  targetPageIds: z.array(z.string()).max(100, "Select up to 100 Facebook pages").default([]),
  intervalMinutes: intervalSchema.default(60),
  captionStrategy: z.enum(["manual", "ai", "hybrid"]),
  captions: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
  aiPrompt: z.string().default(""),
  watermarkEnabled: z.boolean().default(true),
  watermarkSource: z.enum(["page_profile", "custom_logo", "none"]).default("page_profile"),
  watermarkPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("bottom-right"),
  watermarkSizePercent: z.number().min(8).max(30).default(17),
  postingWindowStart: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
  postingWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
  language: z.enum(["th", "en"]).default("th")
});

const DEFAULT_POSTING_WINDOW_START = "00:00";
const DEFAULT_POSTING_WINDOW_END = "23:59";
const LEGACY_POSTING_WINDOW_START = "06:00";
const LEGACY_POSTING_WINDOW_END = "00:00";

function shouldMigrateLegacyPostingWindow(config: { postingWindowStart?: string | null; postingWindowEnd?: string | null; postingWindowCustomized?: boolean | null }) {
  return (
    config.postingWindowCustomized !== true &&
    config.postingWindowStart === LEGACY_POSTING_WINDOW_START &&
    config.postingWindowEnd === LEGACY_POSTING_WINDOW_END
  );
}

export async function GET() {
  try {
    const { requireAuth } = await import("@/lib/api");
    const userId = await requireAuth();
    const config = (await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          nextRunAt: new Date(),
          autoPostStatus: "paused",
          jobStatus: "pending",
          retryCount: 0,
          intervalMinutes: 60,
          contentSource: "shopee-affiliate",
          shopeeSourceTag: "trending",
          shopeeCategory: DEFAULT_SHOPEE_CATEGORY,
          shopeeCategories: [DEFAULT_SHOPEE_CATEGORY],
          shopeeCaptionStyle: "soft_sell",
          approvalMode: false,
          watermarkEnabled: true,
          watermarkSource: "page_profile",
          watermarkPosition: "bottom-right",
          watermarkSizePercent: 17,
          postingWindowStart: DEFAULT_POSTING_WINDOW_START,
          postingWindowEnd: DEFAULT_POSTING_WINDOW_END,
          postingWindowCustomized: false,
          maxPostsPerDay: 0,
          maxPostsPerPagePerDay: 0
        }
      },
      { upsert: true, new: true }
    ).lean()) as LeanAutoPostConfig | null;

    if (!config) {
      return jsonError("Unable to load auto post configuration", 500);
    }

    if (config.folderId === BROKEN_FOLDER_ID) {
      await AutoPostConfig.findOneAndUpdate({ userId }, { folderId: FIXED_FOLDER_ID });
      config.folderId = FIXED_FOLDER_ID;
    }

    if (shouldMigrateLegacyPostingWindow(config)) {
      await AutoPostConfig.findOneAndUpdate(
        { userId },
        {
          postingWindowStart: DEFAULT_POSTING_WINDOW_START,
          postingWindowEnd: DEFAULT_POSTING_WINDOW_END,
          postingWindowCustomized: false
        }
      );
      config.postingWindowStart = DEFAULT_POSTING_WINDOW_START;
      config.postingWindowEnd = DEFAULT_POSTING_WINDOW_END;
      config.postingWindowCustomized = false;
    }

    const normalizedCategories = normalizeShopeeCategories(
      Array.isArray(config.shopeeCategories) && config.shopeeCategories.length ? config.shopeeCategories : config.shopeeCategory
    );
    const normalizedCategory = normalizedCategories[0] ?? DEFAULT_SHOPEE_CATEGORY;
    if (normalizedCategory !== config.shopeeCategory || JSON.stringify(normalizedCategories) !== JSON.stringify(config.shopeeCategories ?? [])) {
      await AutoPostConfig.findOneAndUpdate({ userId }, { shopeeCategory: normalizedCategory, shopeeCategories: normalizedCategories });
      config.shopeeCategory = normalizedCategory;
      config.shopeeCategories = normalizedCategories;
    }

    if (config.lastError) {
      const sanitizedLastError = sanitizeLegacyMessage(config.lastError);
      if (sanitizedLastError !== config.lastError) {
        await AutoPostConfig.findOneAndUpdate({ userId }, { lastError: sanitizedLastError });
        config.lastError = sanitizedLastError;
      }
    }

    if ((config.maxPostsPerDay ?? 0) > 0 || (config.maxPostsPerPagePerDay ?? 0) > 0) {
      await AutoPostConfig.findOneAndUpdate(
        { userId },
        {
          maxPostsPerDay: 0,
          maxPostsPerPagePerDay: 0,
          lastError:
            config.lastError === "Daily Shopee Affiliate post limit reached for selected pages"
              ? null
              : config.lastError ?? null
        }
      );
      config.maxPostsPerDay = 0;
      config.maxPostsPerPagePerDay = 0;
      if (config.lastError === "Daily Shopee Affiliate post limit reached for selected pages") {
        config.lastError = null;
      }
    }

    return jsonOk({ config });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const normalizedFolderId = normalizeFolderId(payload.folderId ?? "root");
    const shopeeKeyword = (payload.shopeeKeyword ?? "").trim();
    const shopeeCategories = normalizeShopeeCategories((payload.shopeeCategories ?? []).length ? payload.shopeeCategories : payload.shopeeCategory);
    const shopeeCategory = shopeeCategories[0] ?? DEFAULT_SHOPEE_CATEGORY;
    const shopeeTrackingId = (payload.shopeeTrackingId ?? "").trim();
    const targetPageIds = uniquePageIds(payload.targetPageIds);
    const current = (await AutoPostConfig.findOne({ userId }).lean()) as LeanAutoPostConfig | null;

    const nextRunAt = payload.enabled
      ? current?.enabled
        ? current.nextRunAt ?? new Date()
        : new Date()
      : current?.nextRunAt ?? new Date();

    const activeStatuses = new Set(["running", "posting", "retrying"]);
    const autoPostStatus = payload.enabled
      ? current?.autoPostStatus && activeStatuses.has(current.autoPostStatus)
        ? current.autoPostStatus
        : "idle"
      : "paused";
    const jobStatus = payload.enabled
      ? activeStatuses.has(autoPostStatus)
        ? current?.jobStatus ?? "processing"
        : "pending"
      : "pending";

    const config = await AutoPostConfig.findOneAndUpdate(
      { userId },
      {
        ...payload,
        contentSource: "shopee-affiliate",
        folderId: normalizedFolderId,
        targetPageIds,
        shopeeKeyword,
        shopeeCategory,
        shopeeCategories,
        shopeeTrackingId,
        shopeeBlockedCategories: (payload.shopeeBlockedCategories ?? []).map((item) => item.trim()).filter(Boolean),
        shopeeCategoryPriority: (payload.shopeeCategoryPriority ?? []).map((item) => item.trim()).filter(Boolean),
        maxPostsPerDay: 0,
        maxPostsPerPagePerDay: 0,
        captions: (payload.captions ?? []).map((caption) => caption.trim()).filter(Boolean),
        hashtags: (payload.hashtags ?? []).map((hashtag) => hashtag.trim()).filter(Boolean),
        watermarkEnabled: payload.watermarkEnabled,
        watermarkSource: payload.watermarkSource,
        watermarkPosition: payload.watermarkPosition,
        watermarkSizePercent: payload.watermarkSizePercent,
        nextRunAt,
        autoPostStatus,
        jobStatus,
        lastStatus: payload.enabled ? "pending" : "paused",
        lastError: null,
        retryCount: payload.enabled ? current?.retryCount ?? 0 : 0,
        postingWindowStart: payload.postingWindowStart,
        postingWindowEnd: payload.postingWindowEnd,
        postingWindowCustomized: true
      },
      { upsert: true, new: true }
    ).lean();

    await logAction({
      userId,
      type: "settings",
      level: "success",
      message: payload.enabled ? "Auto Post configuration updated" : "Auto Post paused",
      metadata: {
        autoPost: true,
        folderId: normalizedFolderId,
        contentSource: "shopee-affiliate",
        shopeeSourceTag: payload.shopeeSourceTag,
        shopeeKeyword,
        shopeeCategory,
        shopeeCategories,
        shopeeCaptionStyle: payload.shopeeCaptionStyle,
        shopeeMinPrice: payload.shopeeMinPrice,
        shopeeMaxPrice: payload.shopeeMaxPrice,
        shopeeMinRating: payload.shopeeMinRating,
        shopeeMinSales: payload.shopeeMinSales,
        shopeeMinDiscountPercent: payload.shopeeMinDiscountPercent,
        approvalMode: payload.approvalMode,
        targetPageCount: targetPageIds.length,
        dedupedTargetPageCount: targetPageIds.length,
        intervalMinutes: payload.intervalMinutes,
        captionStrategy: payload.captionStrategy,
        hashtagCount: (payload.hashtags ?? []).length,
        watermarkEnabled: payload.watermarkEnabled,
        watermarkSource: payload.watermarkSource,
        watermarkPosition: payload.watermarkPosition,
        watermarkSizePercent: payload.watermarkSizePercent,
        postingWindowStart: payload.postingWindowStart,
        postingWindowEnd: payload.postingWindowEnd,
        maxTargetPages: 100,
        imageAssignmentMode: "unique-per-page"
      }
    });

    return jsonOk({ config }, payload.enabled ? "Auto Post settings saved" : "Auto Post paused");
  } catch (error) {
    return handleRoleError(error);
  }
}

