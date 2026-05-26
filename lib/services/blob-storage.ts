import { randomUUID } from "crypto";
import { del, list, put } from "@vercel/blob";
import { AiGeneratedImage } from "@/models/AiGeneratedImage";
import { AiGeneratedPost } from "@/models/AiGeneratedPost";

type BlobKind = "image" | "preview" | "temp";

type UploadAutoPostImageInput = {
  jobId: string;
  productId: string;
  index?: number;
  filename?: string;
  buffer: Buffer;
  mimeType?: string;
  kind?: BlobKind;
};

type BlobCleanupCounts = {
  images: number;
  publishedImages: number;
  previews: number;
  temp: number;
  rawOpenAi: number;
};

const HOUR_MS = 60 * 60 * 1000;
const LARGE_STRING_LIMIT = 250_000;

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertBlobConfigured() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Missing env: BLOB_READ_WRITE_TOKEN");
  }
}

function sanitizeBlobSegment(value: string | number | undefined | null, fallback = "unknown") {
  const normalized = String(value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return normalized || fallback;
}

function contentExtension(mimeType: string) {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

function uniqueBlobToken() {
  return `${Date.now()}-${randomUUID()}`;
}

function buildImagePath(input: UploadAutoPostImageInput) {
  const jobId = sanitizeBlobSegment(input.jobId, "job");
  const productId = sanitizeBlobSegment(input.productId, "product");
  const mimeType = input.mimeType || "image/png";
  const extension = contentExtension(mimeType);
  const kind = input.kind ?? "image";
  const unique = uniqueBlobToken();

  if (kind === "temp") {
    const filenameBase = sanitizeBlobSegment(input.filename?.replace(/\.[^.]+$/, ""), productId);
    return `auto-post/temp/${jobId}/${filenameBase}-${unique}.${extension}`;
  }

  const index = Number.isFinite(input.index) ? input.index : 0;
  const prefix = kind === "preview" ? "auto-post/previews" : "auto-post/images";
  return `${prefix}/${jobId}/${productId}-${index}-${unique}.${extension}`;
}

function isBlobAlreadyExistsError(error: unknown) {
  return error instanceof Error && /already exists|allowOverwrite|addRandomSuffix/i.test(error.message);
}

async function putUniqueBlob(
  pathname: string,
  body: Buffer,
  options: {
    contentType: string;
    fallbackPathname: () => string;
  }
) {
  try {
    return await put(pathname, body, {
      access: "public",
      contentType: options.contentType,
      addRandomSuffix: true
    });
  } catch (error) {
    if (!isBlobAlreadyExistsError(error)) {
      throw error;
    }

    return put(options.fallbackPathname(), body, {
      access: "public",
      contentType: options.contentType,
      addRandomSuffix: true
    });
  }
}

export async function uploadAutoPostImage(input: UploadAutoPostImageInput) {
  assertBlobConfigured();

  const mimeType = input.mimeType || "image/png";
  const pathname = buildImagePath(input);
  const result = await putUniqueBlob(pathname, input.buffer, {
    contentType: mimeType,
    fallbackPathname: () => buildImagePath(input)
  });

  return {
    url: result.url,
    pathname: result.pathname,
    provider: "vercel_blob",
    contentType: mimeType,
    sizeBytes: input.buffer.byteLength,
    createdAt: new Date()
  };
}

export async function uploadAutoPostRawOpenAiResponse(input: {
  jobId: string;
  value: unknown;
}) {
  assertBlobConfigured();

  const jobId = sanitizeBlobSegment(input.jobId, "job");
  const buildPathname = () => `auto-post/raw-openai/${jobId}-${uniqueBlobToken()}.json`;
  const pathname = buildPathname();
  const body = Buffer.from(JSON.stringify(input.value, null, 2), "utf8");
  const result = await putUniqueBlob(pathname, body, {
    contentType: "application/json",
    fallbackPathname: buildPathname
  });

  return {
    url: result.url,
    pathname: result.pathname,
    provider: "vercel_blob",
    contentType: "application/json",
    sizeBytes: body.byteLength,
    createdAt: new Date()
  };
}

async function deleteOldBlobsByPrefix(prefix: string, cutoff: Date) {
  assertBlobConfigured();

  let cursor: string | undefined;
  let deleted = 0;

  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    const oldBlobs = result.blobs.filter((blob) => {
      const uploadedAt = blob.uploadedAt ? new Date(blob.uploadedAt) : null;
      return uploadedAt ? uploadedAt < cutoff : false;
    });

    if (oldBlobs.length > 0) {
      await del(oldBlobs.map((blob) => blob.pathname));
      deleted += oldBlobs.length;
    }

    cursor = result.cursor;
  } while (cursor);

  return deleted;
}

async function cleanupUnusedGeneratedImageBlobs(cutoff: Date) {
  assertBlobConfigured();

  const unusedImages = await AiGeneratedImage.find({
    createdAt: { $lt: cutoff },
    status: { $in: ["pending", "generating", "failed", "skipped"] },
    provider: /vercel_blob|openai_shopee_ugc_photo/i,
    pathname: { $type: "string", $ne: "" }
  })
    .select("pathname status")
    .limit(1000)
    .lean<Array<{ _id: unknown; pathname?: string; status?: string }>>();

  const pathnames = unusedImages
    .map((image) => image.pathname)
    .filter((pathname): pathname is string => Boolean(pathname?.startsWith("auto-post/images/")));

  if (pathnames.length === 0) return 0;

  await del(Array.from(new Set(pathnames)));
  return pathnames.length;
}

function collectImageIdsFromPostMeta(meta: unknown) {
  if (!meta || typeof meta !== "object") return [];
  const data = meta as { imageId?: unknown; imageIds?: unknown; generatedImageUrls?: unknown };
  const ids = new Set<string>();

  if (typeof data.imageId === "string" && data.imageId.trim()) {
    ids.add(data.imageId.trim());
  }

  if (Array.isArray(data.imageIds)) {
    data.imageIds.forEach((value) => {
      if (typeof value === "string" && value.trim()) ids.add(value.trim());
    });
  }

  if (Array.isArray(data.generatedImageUrls)) {
    data.generatedImageUrls.forEach((value) => {
      if (typeof value !== "string") return;
      const match = value.match(/^ai-image:(.+)$/);
      if (match?.[1]?.trim()) ids.add(match[1].trim());
    });
  }

  return Array.from(ids);
}

async function cleanupPublishedGeneratedImageBlobs(cutoff: Date) {
  assertBlobConfigured();

  const publishedPosts = await AiGeneratedPost.find({
    updatedAt: { $lt: cutoff },
    status: "published",
    generationMetaJson: { $exists: true }
  })
    .select("generationMetaJson")
    .limit(1000)
    .lean<Array<{ generationMetaJson?: unknown }>>();

  const imageIds = Array.from(
    new Set(publishedPosts.flatMap((post) => collectImageIdsFromPostMeta(post.generationMetaJson)))
  );

  if (imageIds.length === 0) return 0;

  const publishedImages = await AiGeneratedImage.find({
    _id: { $in: imageIds },
    provider: /vercel_blob|openai_shopee_ugc_photo/i,
    pathname: { $type: "string", $ne: "" }
  })
    .select("pathname")
    .limit(1000)
    .lean<Array<{ _id: unknown; pathname?: string }>>();

  const pathnames = publishedImages
    .map((image) => image.pathname)
    .filter((pathname): pathname is string => Boolean(pathname?.startsWith("auto-post/images/")));

  if (pathnames.length === 0) return 0;

  const uniquePathnames = Array.from(new Set(pathnames));
  await del(uniquePathnames);
  await AiGeneratedImage.updateMany(
    { pathname: { $in: uniquePathnames } },
    {
      $set: {
        generatedImageUrl: "",
        pathname: "",
        provider: "vercel_blob_deleted_after_publish",
        blobDeletedAt: new Date(),
        blobDeleteReason: "published_retention_expired"
      }
    }
  );

  return uniquePathnames.length;
}

export async function cleanupAutoPostBlobs(input: {
  aggressive?: boolean;
  reason?: string;
} = {}) {
  const startedAt = new Date();
  const tempHours = input.aggressive ? 1 : envNumber("BLOB_TEMP_RETENTION_HOURS", 6);
  const previewHours = input.aggressive ? 1 : envNumber("BLOB_PREVIEW_RETENTION_HOURS", 24);
  const rawHours = input.aggressive ? 1 : envNumber("BLOB_RAW_OPENAI_RETENTION_HOURS", 24);
  const unusedImageHours = input.aggressive ? 1 : envNumber("BLOB_UNUSED_IMAGE_RETENTION_HOURS", 24);
  const publishedImageHours = input.aggressive ? 24 : envNumber("BLOB_PUBLISHED_IMAGE_RETENTION_HOURS", 72);

  const counts: BlobCleanupCounts = {
    images: 0,
    publishedImages: 0,
    previews: 0,
    temp: 0,
    rawOpenAi: 0
  };

  counts.temp = await deleteOldBlobsByPrefix("auto-post/temp/", new Date(Date.now() - tempHours * HOUR_MS));
  counts.previews = await deleteOldBlobsByPrefix("auto-post/previews/", new Date(Date.now() - previewHours * HOUR_MS));
  counts.rawOpenAi = await deleteOldBlobsByPrefix("auto-post/raw-openai/", new Date(Date.now() - rawHours * HOUR_MS));
  counts.images = await cleanupUnusedGeneratedImageBlobs(new Date(Date.now() - unusedImageHours * HOUR_MS));
  counts.publishedImages = await cleanupPublishedGeneratedImageBlobs(new Date(Date.now() - publishedImageHours * HOUR_MS));

  const deletedTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return {
    ok: true,
    enabled: true,
    reason: input.reason ?? "manual",
    aggressive: Boolean(input.aggressive),
    startedAt,
    finishedAt: new Date(),
    deleted: counts,
    deletedTotal
  };
}

function isLargeMongoField(key: string, value: unknown) {
  const normalizedKey = key.toLowerCase();
  const safeMetadataKeys = new Set(["sizebytes", "bytesize", "contentlength", "contenttype"]);
  const sensitiveKey =
    !safeMetadataKeys.has(normalizedKey) &&
    /(base64|imagebase64|rawimage|rawresponse|rawbuffer|binary|buffer|bytesbase64|filebytes|imagebytes|rawbytes)/i.test(key);
  if (sensitiveKey) return true;

  if (typeof value === "string") {
    return value.startsWith("data:image/") || value.length > LARGE_STRING_LIMIT;
  }

  return Buffer.isBuffer(value);
}

function shouldTraverseMongoPayload(value: unknown) {
  if (!value || typeof value !== "object") return false;
  if (Buffer.isBuffer(value)) return false;
  if (value instanceof Date) return false;

  const maybeBson = value as { _bsontype?: unknown };
  if (typeof maybeBson._bsontype === "string") return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertNoLargeMongoFields(value: unknown, context = "MongoDB payload") {
  const stack: Array<{ path: string; value: unknown }> = [{ path: context, value }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => stack.push({ path: `${current.path}[${index}]`, value: item }));
      continue;
    }

    if (!current.value || typeof current.value !== "object") {
      continue;
    }

    if (!shouldTraverseMongoPayload(current.value)) {
      continue;
    }

    for (const [key, nestedValue] of Object.entries(current.value as Record<string, unknown>)) {
      const path = `${current.path}.${key}`;
      if (isLargeMongoField(key, nestedValue)) {
        throw new Error(`Blocked large MongoDB field: ${path}. Store files/raw payloads in Vercel Blob instead.`);
      }
      stack.push({ path, value: nestedValue });
    }
  }
}
