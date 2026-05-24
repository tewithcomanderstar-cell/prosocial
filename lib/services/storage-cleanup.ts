import mongoose from "mongoose";
import { connectDb } from "@/lib/db";
import { ActionLog } from "@/models/ActionLog";
import { AffiliateLink } from "@/models/AffiliateLink";
import { AffiliatePerformance } from "@/models/AffiliatePerformance";
import { AiGeneratedImage } from "@/models/AiGeneratedImage";
import { AiGeneratedPost } from "@/models/AiGeneratedPost";
import { AuditEntry } from "@/models/AuditEntry";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { Job } from "@/models/Job";
import { MediaCache } from "@/models/MediaCache";
import { Notification } from "@/models/Notification";
import { ProductPostHistory } from "@/models/ProductPostHistory";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { safeLogAction } from "@/lib/services/logging";

type CleanupMode = "normal" | "aggressive";

type CleanupBucket =
  | "logs"
  | "failedLogs"
  | "rawResponses"
  | "previewPosts"
  | "scheduledPosts"
  | "generatedImages"
  | "generatedCaptions"
  | "products"
  | "affiliateLinks"
  | "auditEntries"
  | "notifications"
  | "jobs"
  | "mediaCache"
  | "legacyBase64Images"
  | "dynamicCollections";

type CleanupCounts = Record<CleanupBucket, number>;

type CollectionStat = {
  name: string;
  documents: number;
  sizeBytes: number;
  storageBytes: number;
  indexBytes: number;
};

type StorageCleanupConfig = {
  enabled: boolean;
  limitBytes: number;
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  autoPostLogRetentionDays: number;
  failedJobRetentionDays: number;
  rawResponseRetentionDays: number;
  unusedImageRetentionHours: number;
  previewRetentionHours: number;
};

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SUMMARY_COLLECTIONS = [
  "actionlogs",
  "jobs",
  "mediacaches",
  "facebookpostqueues",
  "aigeneratedimages",
  "aigeneratedposts",
  "affiliatelinks",
  "shopeeproducts",
  "productposthistories",
  "affiliateperformances",
  "raw_openai_responses",
  "raw_shopee_responses",
  "raw_api_responses",
  "error_logs",
  "auto_post_logs",
  "generated_captions",
  "generated_post_images",
  "scheduled_posts",
  "posted_products",
  "affiliate_links",
  "shopee_products"
] as const;

const DYNAMIC_CLEANUP_COLLECTIONS = [
  "raw_openai_responses",
  "raw_shopee_responses",
  "raw_api_responses",
  "error_logs",
  "auto_post_logs",
  "generated_captions",
  "generated_post_images",
  "scheduled_posts"
] as const;

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getStorageCleanupConfig(): StorageCleanupConfig {
  const limitMb = envNumber("MONGODB_STORAGE_LIMIT_MB", envNumber("STORAGE_LIMIT_MB", 512));

  return {
    enabled: process.env.STORAGE_CLEANUP_ENABLED !== "false",
    limitBytes: limitMb * MB,
    warningThresholdPercent: envNumber("STORAGE_WARNING_THRESHOLD_PERCENT", 85),
    criticalThresholdPercent: envNumber("STORAGE_CRITICAL_THRESHOLD_PERCENT", 95),
    autoPostLogRetentionDays: envNumber("AUTO_POST_LOG_RETENTION_DAYS", 7),
    failedJobRetentionDays: envNumber("FAILED_JOB_RETENTION_DAYS", 3),
    rawResponseRetentionDays: envNumber("RAW_RESPONSE_RETENTION_DAYS", 1),
    unusedImageRetentionHours: envNumber("UNUSED_IMAGE_RETENTION_HOURS", 24),
    previewRetentionHours: envNumber("PREVIEW_RETENTION_HOURS", 24)
  };
}

export function isStorageQuotaError(error: unknown) {
  const message =
    error instanceof Error
      ? `${error.name} ${error.message} ${error.stack ?? ""}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");
  const normalized = message.toLowerCase();

  return (
    normalized.includes("space quota") ||
    normalized.includes("quota") && normalized.includes("writes are blocked") ||
    normalized.includes("limit=storage") ||
    normalized.includes("storage") && normalized.includes("blocked")
  );
}

export function mapStorageQuotaMessage(error: unknown) {
  return isStorageQuotaError(error) ? "Storage quota is full. Cleanup required." : null;
}

function emptyCounts(): CleanupCounts {
  return {
    logs: 0,
    failedLogs: 0,
    rawResponses: 0,
    previewPosts: 0,
    scheduledPosts: 0,
    generatedImages: 0,
    generatedCaptions: 0,
    products: 0,
    affiliateLinks: 0,
    auditEntries: 0,
    notifications: 0,
    jobs: 0,
    mediaCache: 0,
    legacyBase64Images: 0,
    dynamicCollections: 0
  };
}

function dateBefore(msAgo: number) {
  return new Date(Date.now() - msAgo);
}

async function safeCollectionExists(name: string) {
  const db = mongoose.connection.db;
  if (!db) return false;

  const matches = await db.listCollections({ name }).toArray();
  return matches.length > 0;
}

async function safeCollectionStats(name: string): Promise<CollectionStat | null> {
  const db = mongoose.connection.db;
  if (!db || !(await safeCollectionExists(name))) return null;

  try {
    const stats = await db.command({ collStats: name, scale: 1 });
    return {
      name,
      documents: Number(stats.count ?? 0),
      sizeBytes: Number(stats.size ?? 0),
      storageBytes: Number(stats.storageSize ?? 0),
      indexBytes: Number(stats.totalIndexSize ?? 0)
    };
  } catch {
    try {
      return {
        name,
        documents: await db.collection(name).estimatedDocumentCount(),
        sizeBytes: 0,
        storageBytes: 0,
        indexBytes: 0
      };
    } catch {
      return null;
    }
  }
}

async function getDatabaseUsageBytes() {
  const db = mongoose.connection.db;
  if (!db) {
    return {
      usedBytes: 0,
      dataBytes: 0,
      storageBytes: 0,
      indexBytes: 0
    };
  }

  const stats = await db.stats();
  const dataBytes = Number(stats.dataSize ?? 0);
  const storageBytes = Number(stats.storageSize ?? dataBytes);
  const indexBytes = Number(stats.indexSize ?? 0);

  return {
    // Use logical data + index size for quota decisions. WiredTiger storageSize may
    // stay high after deletes until compaction, which makes cleanup look ineffective.
    usedBytes: dataBytes + indexBytes,
    dataBytes,
    storageBytes,
    indexBytes
  };
}

async function getLatestCleanupSummary() {
  const latest = (await ActionLog.findOne({
    "metadata.cleanup": true,
    "metadata.cleanupType": "storage"
  })
    .sort({ createdAt: -1 })
    .select("createdAt metadata")
    .lean()) as { createdAt?: Date; metadata?: Record<string, unknown> } | null;

  const metadata = (latest?.metadata ?? {}) as Record<string, unknown>;
  return latest
    ? {
        at: latest.createdAt ?? null,
        deletedCount: Number(metadata.deletedTotal ?? 0),
        estimatedFreedBytes: Number(metadata.estimatedFreedBytes ?? 0),
        mode: typeof metadata.mode === "string" ? metadata.mode : "normal"
      }
    : null;
}

export async function ensureStorageIndexes() {
  await connectDb();
  const db = mongoose.connection.db;
  if (!db) return;

  await Promise.allSettled([
    ActionLog.collection.createIndex({ createdAt: 1, level: 1, "metadata.autoPost": 1 }),
    Job.collection.createIndex({ createdAt: 1, status: 1, "payload.autoSource": 1 }),
    FacebookPostQueue.collection.createIndex({ createdAt: 1, status: 1, productId: 1 }),
    AiGeneratedImage.collection.createIndex({ createdAt: 1, status: 1, productId: 1 }),
    AiGeneratedPost.collection.createIndex({ createdAt: 1, status: 1, productId: 1 }),
    ShopeeProduct.collection.createIndex({ fetchedAt: 1, productId: 1 }),
    AffiliateLink.collection.createIndex({ createdAt: 1, status: 1, productId: 1 }),
    ProductPostHistory.collection.createIndex({ postedAt: -1, status: 1, productId: 1 }),
    AffiliatePerformance.collection.createIndex({ updatedAt: -1, productId: 1 })
  ]);
}

export async function getStorageStatus() {
  await connectDb();
  const db = mongoose.connection.db;
  const config = getStorageCleanupConfig();
  const usage = await getDatabaseUsageBytes();
  const percent = config.limitBytes > 0 ? Math.round((usage.usedBytes / config.limitBytes) * 1000) / 10 : 0;

  const collectionNames = db
    ? Array.from(
        new Set([
          ...SUMMARY_COLLECTIONS,
          ...(await db.listCollections().toArray()).map((collection) => collection.name)
        ])
      )
    : [...SUMMARY_COLLECTIONS];
  const collectionStats = (await Promise.all(collectionNames.map((name) => safeCollectionStats(name))))
    .filter((item): item is CollectionStat => Boolean(item))
    .sort((a, b) => b.storageBytes + b.indexBytes - (a.storageBytes + a.indexBytes));

  return {
    enabled: config.enabled,
    usedBytes: usage.usedBytes,
    dataBytes: usage.dataBytes,
    storageBytes: usage.storageBytes,
    indexBytes: usage.indexBytes,
    limitBytes: config.limitBytes,
    percent,
    warningThresholdPercent: config.warningThresholdPercent,
    criticalThresholdPercent: config.criticalThresholdPercent,
    status:
      percent >= config.criticalThresholdPercent
        ? "critical"
        : percent >= config.warningThresholdPercent
          ? "warning"
          : "ok",
    lastCleanup: await getLatestCleanupSummary(),
    collections: collectionStats.slice(0, 12)
  };
}

async function deleteDynamicCollectionRows(name: string, cutoff: Date, aggressive: boolean) {
  const db = mongoose.connection.db;
  if (!db || !(await safeCollectionExists(name))) return 0;

  const collection = db.collection(name);
  const failedStatuses = aggressive ? ["failed", "cancelled", "skipped", "error"] : ["failed", "cancelled", "error"];
  const queries = [
    { createdAt: { $lt: cutoff } },
    { updatedAt: { $lt: cutoff }, status: { $in: failedStatuses } }
  ];
  let deleted = 0;

  for (const query of queries) {
    try {
      const result = await collection.deleteMany(query);
      deleted += result.deletedCount ?? 0;
    } catch {
      // Some legacy collections may not have the expected fields; skip safely.
    }
  }

  return deleted;
}

async function getProtectedProductIds() {
  const thirtyDaysAgo = dateBefore(30 * DAY_MS);
  const [postedProducts, activeLinks, activeQueue, analyticsProducts] = await Promise.all([
    ProductPostHistory.distinct("productId", {
      postedAt: { $gte: thirtyDaysAgo },
      status: { $in: ["queued", "published"] }
    }),
    AffiliateLink.distinct("productId", {
      updatedAt: { $gte: thirtyDaysAgo },
      status: "active"
    }),
    FacebookPostQueue.distinct("productId", {
      status: { $in: ["draft", "generated", "image_ready", "queued", "scheduled", "publishing", "published"] }
    }),
    AffiliatePerformance.distinct("productId", {
      updatedAt: { $gte: thirtyDaysAgo }
    })
  ]);

  return Array.from(new Set([...postedProducts, ...activeLinks, ...activeQueue, ...analyticsProducts].map(String)));
}

async function deleteByBatches(collection: mongoose.Collection, query: Record<string, unknown>, batchSize = 250) {
  let deleted = 0;

  for (;;) {
    const docs = await collection
      .find(query, { projection: { _id: 1 } })
      .limit(batchSize)
      .toArray();

    if (docs.length === 0) break;

    const result = await collection.deleteMany({ _id: { $in: docs.map((doc) => doc._id) } });
    deleted += result.deletedCount ?? 0;

    if (docs.length < batchSize) break;
  }

  return deleted;
}

export async function runStorageCleanup(input: {
  userId?: string;
  aggressive?: boolean;
  reason?: string;
} = {}) {
  await connectDb();
  const config = getStorageCleanupConfig();
  const startedAt = new Date();
  const before = await getStorageStatus();
  const shouldForceAggressive = before.percent >= config.criticalThresholdPercent;
  const emergency = before.percent >= 100;
  const aggressive = input.aggressive || shouldForceAggressive;
  const mode: CleanupMode = aggressive ? "aggressive" : "normal";
  const counts = emptyCounts();

  if (!config.enabled) {
    return {
      ok: true,
      enabled: false,
      mode,
      startedAt,
      finishedAt: new Date(),
      deleted: counts,
      deletedTotal: 0,
      estimatedFreedBytes: 0,
      before,
      after: before
    };
  }

  if (!aggressive) {
    await ensureStorageIndexes().catch((error) => {
      console.warn("[storage-cleanup] skipped index creation before cleanup", {
        message: error instanceof Error ? error.message : "Unknown index error"
      });
    });
  }

  const logsCutoff = emergency ? dateBefore(0) : aggressive ? dateBefore(HOUR_MS) : dateBefore(config.autoPostLogRetentionDays * DAY_MS);
  const failedCutoff = emergency ? dateBefore(0) : aggressive ? dateBefore(HOUR_MS) : dateBefore(config.failedJobRetentionDays * DAY_MS);
  const rawCutoff = aggressive ? dateBefore(0) : dateBefore(config.rawResponseRetentionDays * DAY_MS);
  const previewCutoff = aggressive ? dateBefore(0) : dateBefore(config.previewRetentionHours * HOUR_MS);
  const unusedImageCutoff = aggressive ? dateBefore(0) : dateBefore(config.unusedImageRetentionHours * HOUR_MS);
  const staleProductCutoff = aggressive ? dateBefore(0) : dateBefore(7 * DAY_MS);
  const protectedProductIds = await getProtectedProductIds();

  const autoPostLogDelete = await ActionLog.deleteMany({
    createdAt: { $lt: logsCutoff },
    $or: [
      { "metadata.autoPost": true },
      { "metadata.shopeeAffiliate": true },
      { message: /Shopee|Auto Post|auto post|QUEUE_|JOB_/i }
    ]
  });
  counts.logs += autoPostLogDelete.deletedCount ?? 0;

  const failedLogDelete = await ActionLog.deleteMany({
    createdAt: { $lt: failedCutoff },
    level: "error",
    $or: [{ "metadata.autoPost": true }, { "metadata.shopeeAffiliate": true }, { type: "error" }]
  });
  counts.failedLogs += failedLogDelete.deletedCount ?? 0;

  const auditDelete = await AuditEntry.deleteMany({
    createdAt: { $lt: logsCutoff },
    $or: [
      { action: { $in: ["queue-action", "post-action", "system-event", "settings-update", "analytics-action"] } },
      { entityType: { $in: ["queue", "post", "error", "settings", "analytics"] } },
      { summary: /Shopee|Auto Post|auto post|QUEUE_|JOB_/i }
    ]
  });
  counts.auditEntries += auditDelete.deletedCount ?? 0;

  const notificationDelete = await Notification.deleteMany({
    createdAt: { $lt: failedCutoff },
    type: { $in: ["error", "system", "rate_limit"] }
  });
  counts.notifications += notificationDelete.deletedCount ?? 0;

  const mediaCacheDelete = await MediaCache.deleteMany(
    emergency
      ? {}
      : {
          $or: [
            { expiresAt: { $lt: new Date() } },
            { createdAt: { $lt: previewCutoff } },
            { source: { $in: ["google-drive", "upload", "auto-post"] } }
          ]
        }
  );
  counts.mediaCache += mediaCacheDelete.deletedCount ?? 0;

  const legacyBase64Query = {
    generatedImageUrl: /^data:image\//,
    ...(emergency
      ? {}
      : {
          $or: [
            { createdAt: { $lt: unusedImageCutoff } },
            { status: { $in: ["failed", "skipped", "pending", "generating"] } }
          ]
        })
  };
  counts.legacyBase64Images += await deleteByBatches(AiGeneratedImage.collection, legacyBase64Query, emergency ? 500 : 200);

  const failedImageDelete = await AiGeneratedImage.deleteMany({
    createdAt: { $lt: unusedImageCutoff },
    status: { $in: ["failed", "skipped"] }
  });
  counts.generatedImages += failedImageDelete.deletedCount ?? 0;

  const unusedGeneratedImageDelete = await AiGeneratedImage.deleteMany({
    createdAt: { $lt: unusedImageCutoff },
    status: { $in: ["pending", "generating", "generated"] },
    productId: { $nin: protectedProductIds }
  });
  counts.generatedImages += unusedGeneratedImageDelete.deletedCount ?? 0;

  const previewPostDelete = await AiGeneratedPost.deleteMany({
    createdAt: { $lt: previewCutoff },
    status: { $in: ["draft", "generated", "failed", "cancelled"] },
    productId: { $nin: protectedProductIds }
  });
  counts.previewPosts += previewPostDelete.deletedCount ?? 0;
  counts.generatedCaptions += previewPostDelete.deletedCount ?? 0;

  const scheduledPostDelete = await FacebookPostQueue.deleteMany({
    createdAt: { $lt: failedCutoff },
    status: { $in: ["failed", "cancelled"] },
    productId: { $nin: protectedProductIds }
  });
  counts.scheduledPosts += scheduledPostDelete.deletedCount ?? 0;

  const failedJobDelete = await Job.deleteMany({
    createdAt: { $lt: failedCutoff },
    status: { $in: ["failed", "duplicate_blocked"] },
    "payload.autoSource": "shopee-affiliate"
  });
  counts.jobs += failedJobDelete.deletedCount ?? 0;

  const staleProductDelete = await ShopeeProduct.deleteMany({
    fetchedAt: { $lt: staleProductCutoff },
    productId: { $nin: protectedProductIds }
  });
  counts.products += staleProductDelete.deletedCount ?? 0;

  const staleAffiliateLinkDelete = await AffiliateLink.deleteMany({
    createdAt: { $lt: failedCutoff },
    status: { $in: ["failed", "disabled", "pending"] },
    productId: { $nin: protectedProductIds }
  });
  counts.affiliateLinks += staleAffiliateLinkDelete.deletedCount ?? 0;

  for (const collectionName of DYNAMIC_CLEANUP_COLLECTIONS) {
    const cutoff = collectionName.startsWith("raw_") ? rawCutoff : failedCutoff;
    const deleted = await deleteDynamicCollectionRows(collectionName, cutoff, aggressive);
    if (collectionName.startsWith("raw_")) {
      counts.rawResponses += deleted;
    } else if (collectionName.includes("image")) {
      counts.generatedImages += deleted;
    } else if (collectionName.includes("caption")) {
      counts.generatedCaptions += deleted;
    } else {
      counts.dynamicCollections += deleted;
    }
  }

  const after = await getStorageStatus();
  const deletedTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const estimatedFreedBytes = Math.max(0, before.usedBytes - after.usedBytes);
  const finishedAt = new Date();

  if (input.userId && !emergency) {
    await safeLogAction({
      userId: input.userId,
      type: "queue",
      level: "success",
      message: `Storage cleanup completed (${mode})`,
      metadata: {
        cleanup: true,
        cleanupType: "storage",
        mode,
        reason: input.reason ?? "manual",
        forcedAggressive: shouldForceAggressive,
        emergency,
        deleted: counts,
        deletedTotal,
        estimatedFreedBytes,
        beforePercent: before.percent,
        afterPercent: after.percent,
        startedAt,
        finishedAt
      }
    });
  }

  return {
    ok: true,
    enabled: true,
    mode,
    startedAt,
    finishedAt,
    deleted: counts,
    deletedTotal,
    estimatedFreedBytes,
    before,
    after
  };
}

export async function ensureStorageBeforeAutoPost(userId?: string) {
  const status = await getStorageStatus();
  const config = getStorageCleanupConfig();

  if (!config.enabled || status.percent < config.warningThresholdPercent) {
    return {
      ok: true,
      action: "none" as const,
      status
    };
  }

  const aggressive = status.percent >= config.criticalThresholdPercent;
  const cleanup = await runStorageCleanup({
    userId,
    aggressive,
    reason: aggressive ? "critical_before_auto_post" : "warning_before_auto_post"
  });
  const after = cleanup.after;

  if (after.percent >= config.criticalThresholdPercent) {
    throw new Error("Storage quota is full. Cleanup required.");
  }

  return {
    ok: true,
    action: aggressive ? ("aggressive_cleanup" as const) : ("cleanup" as const),
    status: after,
    cleanup
  };
}
