import crypto from "crypto";
import {
  buildShopeeImagePromptSet as buildShopeeImagePromptSetCore,
  isShopeeProductNameDuplicateText,
  removeDuplicateShopeeProductNameLines,
  stripShopeeProductNameFromText
} from "@/lib/services/shopee-affiliate-core";
import { generateFacebookContent, generateProductReferenceImage } from "@/lib/services/ai";
import { assertNoLargeMongoFields, uploadAutoPostImage } from "@/lib/services/blob-storage";
import { logAction } from "@/lib/services/logging";
import { randomItem } from "@/lib/utils";
import { AffiliateLink } from "@/models/AffiliateLink";
import { AffiliatePerformance } from "@/models/AffiliatePerformance";
import { AiGeneratedImage } from "@/models/AiGeneratedImage";
import { AiGeneratedPost } from "@/models/AiGeneratedPost";
import { AutomationLog } from "@/models/AutomationLog";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { ProductPostHistory } from "@/models/ProductPostHistory";
import { ShopeeProduct } from "@/models/ShopeeProduct";

export type ShopeeSourceTag = "trending" | "best_selling" | "top_search" | "best_roi" | "manual";
export type ShopeeCaptionStyle = "soft_sell" | "urgency" | "problem_solution" | "review_style" | "deal_alert" | "lifestyle";

const SHOPEE_MAX_HASHTAGS = 5;

export type ShopeeProductRecord = {
  productId: string;
  shopId: string;
  itemId: string;
  productName: string;
  productDescription: string;
  productPrice: number;
  discountPrice?: number;
  discountPercent?: number;
  productImageUrl: string;
  productImageUrls?: string[];
  productUrl: string;
  affiliateUrl?: string;
  category: string;
  salesCount?: number;
  reviewCount?: number;
  shopName?: string;
  rating?: number;
  commissionRate?: number;
  sourceTag: ShopeeSourceTag;
  fetchedAt: Date;
};

export type ProductDiscoveryQuery = {
  sourceTag?: ShopeeSourceTag;
  keyword?: string;
  category?: string;
  limit?: number;
};

export type ProductScore = {
  productScore: number;
  reason: string[];
  riskFlags: string[];
};

export type ShopeePostPackage = {
  product: ShopeeProductRecord;
  caption: string;
  imagePrompt: string;
  imagePrompts: string[];
  generatedImageUrl: string;
  generatedImageUrls: string[];
  affiliateLink: string;
  shortAffiliateLink: string;
  imageStatus: "pending" | "generating" | "generated" | "failed" | "skipped";
  scheduledAt: Date;
  pageId: string;
  status: "draft" | "generated" | "image_ready" | "queued" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
};

export interface ShopeeProductProvider {
  name: string;
  fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]>;
}

type ShopeeEnvStatus = {
  ok: boolean;
  providerMode: "mock" | "official";
  missing: string[];
  configured: string[];
  optionalMissing: string[];
};

type ShopeeAuthMode = "affiliate_graphql" | "open_platform_query" | "affiliate_headers" | "unsigned";

export class ShopeeProviderError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = "shopee_provider_error",
    public readonly source: "shopee_api" | "config" | "internal_api" | "unknown" = "unknown",
    public readonly responseSummary?: string
  ) {
    super(message);
    this.name = "ShopeeProviderError";
  }
}

export type ShopeeSubIdFields = {
  subId?: string | null;
  subId1?: string | null;
  subId2?: string | null;
  subId3?: string | null;
  subId4?: string | null;
  subId5?: string | null;
};

export const SHOPEE_SUB_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const SHOPEE_SUB_ID_ERROR_MESSAGE = "Sub ID à¹ƒà¸Šà¹‰à¹„à¸”à¹‰à¹€à¸‰à¸žà¸²à¸° a-z, A-Z, 0-9, _ à¹à¸¥à¸° - à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™";

const SHOPEE_SUB_ID_KEYS = ["subId", "subId1", "subId2", "subId3", "subId4", "subId5"] as const;

function normalizeShopeeSubId(value?: string | null) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeShopeeSubIds(input: ShopeeSubIdFields = {}): Required<ShopeeSubIdFields> {
  return {
    subId: normalizeShopeeSubId(input.subId),
    subId1: normalizeShopeeSubId(input.subId1),
    subId2: normalizeShopeeSubId(input.subId2),
    subId3: normalizeShopeeSubId(input.subId3),
    subId4: normalizeShopeeSubId(input.subId4),
    subId5: normalizeShopeeSubId(input.subId5)
  };
}

export function validateShopeeSubIds(input: ShopeeSubIdFields = {}) {
  const normalized = normalizeShopeeSubIds(input);
  for (const key of SHOPEE_SUB_ID_KEYS) {
    const value = normalized[key];
    if (value && !SHOPEE_SUB_ID_PATTERN.test(value)) {
      throw new ShopeeProviderError(SHOPEE_SUB_ID_ERROR_MESSAGE, 400, "shopee_sub_id_invalid", "config");
    }
  }
  return normalized;
}

function hasAnyShopeeSubId(input: ShopeeSubIdFields = {}) {
  const normalized = normalizeShopeeSubIds(input);
  return SHOPEE_SUB_ID_KEYS.some((key) => Boolean(normalized[key]));
}

export function getShopeeSubIdCacheKey(input: ShopeeSubIdFields = {}) {
  const normalized = normalizeShopeeSubIds(input);
  return SHOPEE_SUB_ID_KEYS.map((key) => `${key}:${normalized[key] || "-"}`).join("|");
}

export function resolveShopeeSubIds(input: {
  pageSubIds?: ShopeeSubIdFields | null;
  configSubIds?: ShopeeSubIdFields | null;
} = {}) {
  const envSubIds = normalizeShopeeSubIds({
    subId: process.env.SHOPEE_DEFAULT_SUB_ID,
    subId1: process.env.SHOPEE_DEFAULT_SUB_ID1,
    subId2: process.env.SHOPEE_DEFAULT_SUB_ID2,
    subId3: process.env.SHOPEE_DEFAULT_SUB_ID3,
    subId4: process.env.SHOPEE_DEFAULT_SUB_ID4,
    subId5: process.env.SHOPEE_DEFAULT_SUB_ID5
  });
  const configSubIds = normalizeShopeeSubIds(input.configSubIds ?? {});
  const pageSubIds = normalizeShopeeSubIds(input.pageSubIds ?? {});
  const resolved: ShopeeSubIdFields = {};

  for (const key of SHOPEE_SUB_ID_KEYS) {
    resolved[key] = pageSubIds[key] || configSubIds[key] || envSubIds[key] || "";
  }

  return validateShopeeSubIds(resolved);
}

export function buildShopeeAffiliatePayload(input: {
  productUrl: string;
  trackingId?: string | null;
  subId?: string | null;
  subIds?: ShopeeSubIdFields | null;
}) {
  const subIds = validateShopeeSubIds({ ...(input.subIds ?? {}), subId: input.subId ?? input.subIds?.subId });
  const payload: Record<string, string> = {
    url: input.productUrl
  };
  const trackingId = input.trackingId?.trim();
  if (trackingId) payload.tracking_id = trackingId;
  if (subIds.subId) payload.sub_id = subIds.subId;
  if (subIds.subId1) payload.sub_id1 = subIds.subId1;
  if (subIds.subId2) payload.sub_id2 = subIds.subId2;
  if (subIds.subId3) payload.sub_id3 = subIds.subId3;
  if (subIds.subId4) payload.sub_id4 = subIds.subId4;
  if (subIds.subId5) payload.sub_id5 = subIds.subId5;
  return payload;
}

function hasEnv(name: string) {
  return Boolean(process.env[name]?.trim());
}

function firstEnv(names: string[]) {
  return names.map((name) => process.env[name]?.trim()).find(Boolean);
}

function configuredEnvNames(names: string[]) {
  return names.filter(hasEnv);
}

function getShopeeCredentialEnv() {
  const partnerIdNames = ["SHOPEE_PARTNER_ID", "SHOPEE_APP_ID"];
  const partnerKeyNames = ["SHOPEE_PARTNER_KEY", "SHOPEE_API_SECRET", "SHOPEE_APP_SECRET"];

  return {
    partnerId: firstEnv(partnerIdNames),
    partnerKey: firstEnv(partnerKeyNames),
    partnerIdNames,
    partnerKeyNames
  };
}

function getShopeeAuthMode(): ShopeeAuthMode {
  const value = process.env.SHOPEE_AUTH_MODE?.trim().toLowerCase();
  if (value === "affiliate_graphql" || value === "affiliate_headers" || value === "unsigned" || value === "open_platform_query") {
    return value;
  }
  if (process.env.SHOPEE_AFFILIATE_API_URL?.trim().toLowerCase().includes("/graphql")) {
    return "affiliate_graphql";
  }
  return "open_platform_query";
}

export function getShopeeEnvStatus(): ShopeeEnvStatus {
  const providerMode = process.env.SHOPEE_PROVIDER?.trim().toLowerCase() === "mock" ? "mock" : "official";
  const credentials = getShopeeCredentialEnv();
  const requiredGroups = [
    { label: "SHOPEE_AFFILIATE_API_URL", ok: hasEnv("SHOPEE_AFFILIATE_API_URL") },
    { label: "SHOPEE_PARTNER_ID or SHOPEE_APP_ID", ok: Boolean(credentials.partnerId) },
    { label: "SHOPEE_PARTNER_KEY or SHOPEE_API_SECRET", ok: Boolean(credentials.partnerKey) }
  ];
  const optional = [
    "SHOPEE_AFFILIATE_ID",
    "SHOPEE_TRACKING_ID",
    "SHOPEE_AFFILIATE_BASE_URL",
    "SHOPEE_REGION",
    "SHOPEE_API_SECRET",
    "SHOPEE_APP_ID",
    "SHOPEE_APP_SECRET",
    "SHOPEE_AUTH_MODE",
    "SHOPEE_AFFILIATE_QUERY_MODE",
    "BLOB_READ_WRITE_TOKEN",
    "CRON_SECRET"
  ];
  const missing = providerMode === "mock" ? [] : requiredGroups.filter((item) => !item.ok).map((item) => item.label);
  const configured = [
    "SHOPEE_AFFILIATE_API_URL",
    ...configuredEnvNames(credentials.partnerIdNames),
    ...configuredEnvNames(credentials.partnerKeyNames),
    ...optional,
    "SHOPEE_PROVIDER"
  ].filter((name, index, list) => hasEnv(name) && list.indexOf(name) === index);

  return {
    ok: missing.length === 0,
    providerMode,
    missing,
    configured,
    optionalMissing: optional.filter((name) => !hasEnv(name))
  };
}

export function getShopeeAffiliateConfigStatus(trackingId?: string | null) {
  const missing: string[] = [];
  const hasAffiliateId = hasEnv("SHOPEE_AFFILIATE_ID");
  const hasTracking = Boolean(trackingId?.trim()) || hasEnv("SHOPEE_TRACKING_ID");
  const hasLinkBuilder = hasEnv("SHOPEE_AFFILIATE_BASE_URL");

  if (!hasAffiliateId) missing.push("SHOPEE_AFFILIATE_ID");
  if (!hasTracking) missing.push("SHOPEE_TRACKING_ID or Auto Post Tracking ID");
  if (!hasLinkBuilder) missing.push("SHOPEE_AFFILIATE_BASE_URL");

  return {
    status: missing.length ? "setup_required" : "configured",
    missing
  };
}

export function ensureShopeeAffiliateConfigured(trackingId?: string | null) {
  const status = getShopeeAffiliateConfigStatus(trackingId);
  const missingRuntime: string[] = [];

  if (!hasEnv("BLOB_READ_WRITE_TOKEN")) {
    missingRuntime.push("BLOB_READ_WRITE_TOKEN");
  }

  if (status.status === "setup_required") {
    throw new ShopeeProviderError(
      `Shopee Affiliate setup required. Missing: ${status.missing.join(", ")}`,
      400,
      "shopee_affiliate_setup_required",
      "config"
    );
  }
  if (missingRuntime.length > 0) {
    throw new ShopeeProviderError(
      `Shopee Affiliate storage setup required. Missing: ${missingRuntime.join(", ")}`,
      400,
      "shopee_blob_storage_setup_required",
      "config"
    );
  }
  return status;
}

async function summarizeResponse(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  return text.replace(/\s+/g, " ").slice(0, 500);
}

export class MockShopeeProvider implements ShopeeProductProvider {
  name = "mock_shopee_provider";

  async fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]> {
    const now = new Date();
    const sourceTag = query.sourceTag ?? "trending";
    const keyword = query.keyword?.trim() || "Ã Â¸â€šÃ Â¸Â­Ã Â¸â€¡Ã Â¹Æ’Ã Â¸Å Ã Â¹â€°Ã Â¸Â¢Ã Â¸Â­Ã Â¸â€Ã Â¸â„¢Ã Â¸Â´Ã Â¸Â¢Ã Â¸Â¡";
    const category = query.category?.trim() || "Lifestyle";
    const limit = Math.max(1, Math.min(query.limit ?? 20, 50));

    const samples: ShopeeProductRecord[] = [
      {
        productId: "mock-thermal-cup",
        shopId: "10001",
        itemId: "90001",
        productName: "Ã Â¹ÂÃ Â¸ÂÃ Â¹â€°Ã Â¸Â§Ã Â¹â‚¬Ã Â¸ÂÃ Â¹â€¡Ã Â¸Å¡Ã Â¸Â­Ã Â¸Â¸Ã Â¸â€œÃ Â¸Â«Ã Â¸Â Ã Â¸Â¹Ã Â¸Â¡Ã Â¸Â´Ã Â¸Å¾Ã Â¸ÂÃ Â¸Å¾Ã Â¸Â² 600ml",
        productDescription: "Ã Â¹ÂÃ Â¸ÂÃ Â¹â€°Ã Â¸Â§Ã Â¸ÂªÃ Â¹ÂÃ Â¸â€¢Ã Â¸â„¢Ã Â¹â‚¬Ã Â¸Â¥Ã Â¸ÂªÃ Â¹â‚¬Ã Â¸ÂÃ Â¹â€¡Ã Â¸Å¡Ã Â¹â‚¬Ã Â¸Â¢Ã Â¹â€¡Ã Â¸â„¢/Ã Â¸Â£Ã Â¹â€°Ã Â¸Â­Ã Â¸â„¢ Ã Â¹â‚¬Ã Â¸Â«Ã Â¸Â¡Ã Â¸Â²Ã Â¸Â°Ã Â¸ÂÃ Â¸Â±Ã Â¸Å¡Ã Â¸Â­Ã Â¸Â­Ã Â¸Å¸Ã Â¸Å¸Ã Â¸Â´Ã Â¸Â¨ Ã Â¹â‚¬Ã Â¸â€Ã Â¸Â´Ã Â¸â„¢Ã Â¸â€”Ã Â¸Â²Ã Â¸â€¡ Ã Â¹ÂÃ Â¸Â¥Ã Â¸Â°Ã Â¸ÂªÃ Â¸Â²Ã Â¸Â¢Ã Â¸â€žÃ Â¸Â²Ã Â¹â‚¬Ã Â¸Å¸Ã Â¹Ë†",
        productPrice: 299,
        discountPrice: 159,
        discountPercent: 47,
        productImageUrl: "https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=1200&auto=format&fit=crop",
        productUrl: "https://shopee.co.th/product/10001/90001",
        affiliateUrl: "https://s.shopee.co.th/mockThermalCup",
        category,
        salesCount: 12400,
        rating: 4.8,
        commissionRate: 7,
        sourceTag,
        fetchedAt: now
      },
      {
        productId: "mock-mini-vacuum",
        shopId: "10002",
        itemId: "90002",
        productName: "Ã Â¹â‚¬Ã Â¸â€žÃ Â¸Â£Ã Â¸Â·Ã Â¹Ë†Ã Â¸Â­Ã Â¸â€¡Ã Â¸â€Ã Â¸Â¹Ã Â¸â€Ã Â¸ÂÃ Â¸Â¸Ã Â¹Ë†Ã Â¸â„¢Ã Â¹â€žÃ Â¸Â£Ã Â¹â€°Ã Â¸ÂªÃ Â¸Â²Ã Â¸Â¢Ã Â¸Â¡Ã Â¸Â´Ã Â¸â„¢Ã Â¸Â´",
        productDescription: "Ã Â¸â€šÃ Â¸â„¢Ã Â¸Â²Ã Â¸â€Ã Â¹â‚¬Ã Â¸Â¥Ã Â¹â€¡Ã Â¸Â Ã Â¹Æ’Ã Â¸Å Ã Â¹â€°Ã Â¸â€¡Ã Â¹Ë†Ã Â¸Â²Ã Â¸Â¢ Ã Â¹â‚¬Ã Â¸Â«Ã Â¸Â¡Ã Â¸Â²Ã Â¸Â°Ã Â¸ÂÃ Â¸Â±Ã Â¸Å¡Ã Â¹â€šÃ Â¸â€¢Ã Â¹Å Ã Â¸Â°Ã Â¸â€”Ã Â¸Â³Ã Â¸â€¡Ã Â¸Â²Ã Â¸â„¢ Ã Â¸Â£Ã Â¸â€“Ã Â¸Â¢Ã Â¸â„¢Ã Â¸â€¢Ã Â¹Å’ Ã Â¹ÂÃ Â¸Â¥Ã Â¸Â°Ã Â¸Â¡Ã Â¸Â¸Ã Â¸Â¡Ã Â¹â‚¬Ã Â¸Â¥Ã Â¹â€¡Ã Â¸Â Ã Â¹â€  Ã Â¹Æ’Ã Â¸â„¢Ã Â¸Å¡Ã Â¹â€°Ã Â¸Â²Ã Â¸â„¢",
        productPrice: 490,
        discountPrice: 249,
        discountPercent: 49,
        productImageUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&auto=format&fit=crop",
        productUrl: "https://shopee.co.th/product/10002/90002",
        affiliateUrl: "https://s.shopee.co.th/mockMiniVacuum",
        category,
        salesCount: 8900,
        rating: 4.7,
        commissionRate: 8,
        sourceTag,
        fetchedAt: now
      },
      {
        productId: "mock-led-mirror",
        shopId: "10003",
        itemId: "90003",
        productName: "Ã Â¸ÂÃ Â¸Â£Ã Â¸Â°Ã Â¸Ë†Ã Â¸ÂÃ Â¹ÂÃ Â¸â€¢Ã Â¹Ë†Ã Â¸â€¡Ã Â¸Â«Ã Â¸â„¢Ã Â¹â€°Ã Â¸Â²Ã Â¸Å¾Ã Â¸Â£Ã Â¹â€°Ã Â¸Â­Ã Â¸Â¡Ã Â¹â€žÃ Â¸Å¸ LED",
        productDescription: "Ã Â¹â€žÃ Â¸Å¸Ã Â¸â„¢Ã Â¸Â¸Ã Â¹Ë†Ã Â¸Â¡ Ã Â¸â€ºÃ Â¸Â£Ã Â¸Â±Ã Â¸Å¡Ã Â¸Â¡Ã Â¸Â¸Ã Â¸Â¡Ã Â¹â€žÃ Â¸â€Ã Â¹â€° Ã Â¹â‚¬Ã Â¸Â«Ã Â¸Â¡Ã Â¸Â²Ã Â¸Â°Ã Â¸ÂÃ Â¸Â±Ã Â¸Å¡Ã Â¹â€šÃ Â¸â€¢Ã Â¹Å Ã Â¸Â°Ã Â¹â‚¬Ã Â¸â€žÃ Â¸Â£Ã Â¸Â·Ã Â¹Ë†Ã Â¸Â­Ã Â¸â€¡Ã Â¹ÂÃ Â¸â€ºÃ Â¹â€°Ã Â¸â€¡Ã Â¹ÂÃ Â¸Â¥Ã Â¸Â°Ã Â¸ÂªÃ Â¸Â²Ã Â¸Â¢Ã Â¹ÂÃ Â¸â€¢Ã Â¹Ë†Ã Â¸â€¡Ã Â¸Â«Ã Â¸â„¢Ã Â¹â€°Ã Â¸Â²",
        productPrice: 399,
        discountPrice: 219,
        discountPercent: 45,
        productImageUrl: "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=1200&auto=format&fit=crop",
        productUrl: "https://shopee.co.th/product/10003/90003",
        affiliateUrl: "https://s.shopee.co.th/mockLedMirror",
        category,
        salesCount: 6200,
        rating: 4.9,
        commissionRate: 6,
        sourceTag,
        fetchedAt: now
      },
      {
        productId: "mock-storage-box",
        shopId: "10004",
        itemId: "90004",
        productName: "Ã Â¸ÂÃ Â¸Â¥Ã Â¹Ë†Ã Â¸Â­Ã Â¸â€¡Ã Â¸Ë†Ã Â¸Â±Ã Â¸â€Ã Â¸Â£Ã Â¸Â°Ã Â¹â‚¬Ã Â¸Å¡Ã Â¸ÂµÃ Â¸Â¢Ã Â¸Å¡Ã Â¸Â¥Ã Â¸Â´Ã Â¹â€°Ã Â¸â„¢Ã Â¸Å Ã Â¸Â±Ã Â¸ÂÃ Â¹ÂÃ Â¸Å¡Ã Â¸Å¡Ã Â¹Æ’Ã Â¸Âª",
        productDescription: "Ã Â¸Å Ã Â¹Ë†Ã Â¸Â§Ã Â¸Â¢Ã Â¹ÂÃ Â¸Â¢Ã Â¸ÂÃ Â¸â€šÃ Â¸Â­Ã Â¸â€¡Ã Â¹â‚¬Ã Â¸Â¥Ã Â¹â€¡Ã Â¸Â Ã Â¹â€  Ã Â¹Æ’Ã Â¸Â«Ã Â¹â€°Ã Â¸Â«Ã Â¸Â¢Ã Â¸Â´Ã Â¸Å¡Ã Â¸â€¡Ã Â¹Ë†Ã Â¸Â²Ã Â¸Â¢ Ã Â¹â€šÃ Â¸â€¢Ã Â¹Å Ã Â¸Â°Ã Â¸â€Ã Â¸Â¹Ã Â¹â€šÃ Â¸Â¥Ã Â¹Ë†Ã Â¸â€¡Ã Â¸â€šÃ Â¸Â¶Ã Â¹â€°Ã Â¸â„¢ Ã Â¹â‚¬Ã Â¸Â«Ã Â¸Â¡Ã Â¸Â²Ã Â¸Â°Ã Â¸ÂÃ Â¸Â±Ã Â¸Å¡Ã Â¸Å¡Ã Â¹â€°Ã Â¸Â²Ã Â¸â„¢Ã Â¹ÂÃ Â¸Â¥Ã Â¸Â°Ã Â¸Â­Ã Â¸Â­Ã Â¸Å¸Ã Â¸Å¸Ã Â¸Â´Ã Â¸Â¨",
        productPrice: 199,
        discountPrice: 89,
        discountPercent: 55,
        productImageUrl: "https://images.unsplash.com/photo-1558611848-73f7eb4001a1?w=1200&auto=format&fit=crop",
        productUrl: "https://shopee.co.th/product/10004/90004",
        affiliateUrl: "https://s.shopee.co.th/mockStorageBox",
        category,
        salesCount: 15400,
        rating: 4.6,
        commissionRate: 5,
        sourceTag,
        fetchedAt: now
      }
    ];

    const keywordLower = keyword.toLowerCase();
    const filtered = samples.filter((product) => {
      const haystack = `${product.productName} ${product.productDescription} ${product.category}`.toLowerCase();
      return !query.keyword || haystack.includes(keywordLower) || keywordLower.includes("Ã Â¸Â¢Ã Â¸Â­Ã Â¸â€Ã Â¸â„¢Ã Â¸Â´Ã Â¸Â¢Ã Â¸Â¡");
    });

    return (filtered.length ? filtered : samples).slice(0, limit);
  }
}

export class ShopeeOfficialApiProvider implements ShopeeProductProvider {
  name = "shopee_official_api_provider";

  async fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]> {
    const endpoint = process.env.SHOPEE_AFFILIATE_API_URL;
    const { partnerId, partnerKey } = getShopeeCredentialEnv();
    const envStatus = getShopeeEnvStatus();
    const authMode = getShopeeAuthMode();

    if (envStatus.providerMode === "mock") {
      return new MockShopeeProvider().fetchProducts(query);
    }

    if (!endpoint || !partnerId || !partnerKey) {
      console.warn("[shopee/provider] missing official API env, blocking official fetch", {
        missing: envStatus.missing,
        configured: envStatus.configured
      });
      throw new ShopeeProviderError(
        `Shopee API environment is incomplete. Missing: ${envStatus.missing.join(", ")}`,
        400,
        "shopee_missing_env",
        "config"
      );
    }

    if (authMode === "affiliate_graphql") {
      return fetchShopeeAffiliateGraphqlProducts({
        endpoint,
        appId: partnerId,
        secret: partnerKey,
        query
      });
    }

    // Adapter shell: keep official API specifics isolated so we can swap endpoint contracts safely.
    const url = new URL(endpoint);
    if (query.keyword) url.searchParams.set("keyword", query.keyword);
    if (query.category) url.searchParams.set("category", query.category);
    if (query.sourceTag) url.searchParams.set("source_tag", query.sourceTag);
    url.searchParams.set("limit", String(Math.max(1, Math.min(query.limit ?? 20, 50))));

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signatureBase =
      authMode === "open_platform_query"
        ? `${partnerId}${url.pathname}${timestamp}`
        : `${url.pathname}${url.search}${timestamp}`;
    const signature = crypto.createHmac("sha256", partnerKey).update(signatureBase).digest("hex");

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authMode === "open_platform_query") {
      url.searchParams.set("partner_id", partnerId);
      url.searchParams.set("timestamp", timestamp);
      url.searchParams.set("sign", signature);
    } else if (authMode === "affiliate_headers") {
      headers["x-shopee-partner-id"] = partnerId;
      headers["x-shopee-timestamp"] = timestamp;
      headers["x-shopee-signature"] = signature;
    }

    console.info("[shopee/provider] external product fetch", {
      endpointHost: url.host,
      endpointPath: url.pathname,
      sourceTag: query.sourceTag ?? "trending",
      limit: url.searchParams.get("limit"),
      hasPartnerId: Boolean(partnerId),
      hasPartnerKey: Boolean(partnerKey),
      signatureGenerated: Boolean(signature),
      signatureBaseParts: authMode === "open_platform_query" ? ["partner_id", "path", "timestamp"] : ["path", "query", "timestamp"],
      authMode,
      hasAuthQuery: authMode === "open_platform_query",
      hasAuthHeaders: authMode === "affiliate_headers"
    });

    const response = await fetch(url, {
      headers,
      cache: "no-store"
    });

    if (!response.ok) {
      const bodySummary = await summarizeResponse(response);
      console.warn("[shopee/provider] external product fetch failed", {
        endpointHost: url.host,
        endpointPath: url.pathname,
        status: response.status,
        bodySummary,
        hasPartnerId: Boolean(partnerId),
        hasPartnerKey: Boolean(partnerKey),
        signatureGenerated: Boolean(signature),
        authMode
      });
      const message =
        response.status === 401
          ? `Shopee rejected the request using ${authMode}. Check AppID/Partner ID, Secret/Partner Key, signature mode, timestamp, endpoint path, and region.`
          : `Shopee API request failed: ${response.status}`;
      throw new ShopeeProviderError(message, response.status, response.status === 401 ? "shopee_unauthorized" : "shopee_api_error", "shopee_api", bodySummary);
    }

    const payload = (await response.json()) as { products?: Array<Record<string, unknown>> };
    console.info("[shopee/provider] external product fetch completed", {
      endpointHost: url.host,
      endpointPath: url.pathname,
      productsCount: payload.products?.length ?? 0
    });
    return (payload.products ?? []).map(mapExternalProduct(query.sourceTag ?? "trending"));
  }
}

function getShopeeAffiliateListType(sourceTag?: ShopeeSourceTag) {
  switch (sourceTag) {
    case "best_selling":
      return 1;
    case "top_search":
      return 2;
    case "best_roi":
      return 3;
    case "manual":
      return 0;
    case "trending":
    default:
      return 0;
  }
}

function escapeGraphqlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function buildShopeeAffiliateGraphqlQuery(query: ProductDiscoveryQuery) {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
  const listType = getShopeeAffiliateListType(query.sourceTag);
  const args = [`limit: ${limit}`, "page: 1", `listType: ${listType}`];
  const keyword = query.keyword?.trim() || query.category?.trim();
  if (keyword) args.push(`keyword: "${escapeGraphqlString(keyword)}"`);

  return `query {
  productOfferV2(${args.join(", ")}) {
    nodes {
      productName
      itemId
      shopId
      productLink
      offerLink
      imageUrl
      price
      priceMin
      priceMax
      sales
      ratingStar
      commissionRate
      shopName
    }
  }
}`;
}

function buildShopeeAffiliateGraphqlFallbackQuery(query: ProductDiscoveryQuery) {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
  return `query {
  productOfferV2(limit: ${limit}, page: 1) {
    nodes {
      productName
      itemId
      shopId
      productLink
      offerLink
      imageUrl
      price
      priceMin
      priceMax
      sales
      ratingStar
      commissionRate
      shopName
    }
  }
}`;
}

function isShopeeGraphqlSystemError(payload: Record<string, any>) {
  return Array.isArray(payload.errors) && payload.errors.some((error) => {
    const code = error?.extensions?.code ?? error?.code;
    const message = String(error?.message ?? error?.extensions?.message ?? "").toLowerCase();
    return String(code) === "10000" || message.includes("system error");
  });
}

function normalizeCachedShopeeProduct(product: any, sourceTag: ShopeeSourceTag): ShopeeProductRecord {
  return {
    productId: String(product.productId),
    shopId: String(product.shopId ?? ""),
    itemId: String(product.itemId ?? product.productId),
    productName: String(product.productName ?? "Shopee Product"),
    productDescription: String(product.productDescription ?? ""),
    productPrice: Number(product.productPrice ?? 0),
    discountPrice: product.discountPrice === null || product.discountPrice === undefined ? undefined : Number(product.discountPrice),
    discountPercent: product.discountPercent === null || product.discountPercent === undefined ? undefined : Number(product.discountPercent),
    productImageUrl: String(product.productImageUrl ?? product.productImageUrls?.[0] ?? ""),
    productImageUrls: Array.isArray(product.productImageUrls) ? product.productImageUrls.map(String).filter(Boolean) : undefined,
    productUrl: String(product.productUrl ?? ""),
    affiliateUrl: product.affiliateUrl ? String(product.affiliateUrl) : undefined,
    category: String(product.category ?? "General"),
    salesCount: product.salesCount === undefined || product.salesCount === null ? undefined : Number(product.salesCount),
    reviewCount: product.reviewCount === undefined || product.reviewCount === null ? undefined : Number(product.reviewCount),
    shopName: product.shopName ? String(product.shopName) : undefined,
    rating: product.rating === undefined || product.rating === null ? undefined : Number(product.rating),
    commissionRate: product.commissionRate === undefined || product.commissionRate === null ? undefined : Number(product.commissionRate),
    sourceTag,
    fetchedAt: product.fetchedAt ? new Date(product.fetchedAt) : new Date()
  };
}

async function fetchCachedShopeeProducts(query: ProductDiscoveryQuery, reason: string) {
  const sourceTag = query.sourceTag ?? "trending";
  const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
  const mongoQuery: Record<string, unknown> = {
    productImageUrl: { $ne: "" },
    $or: [{ productUrl: { $ne: "" } }, { affiliateUrl: { $ne: "" } }]
  };
  if (query.category?.trim()) {
    mongoQuery.category = { $regex: query.category.trim(), $options: "i" };
  }
  if (query.keyword?.trim()) {
    const keyword = query.keyword.trim();
    mongoQuery.$and = [
      {
        $or: [
          { productName: { $regex: keyword, $options: "i" } },
          { productDescription: { $regex: keyword, $options: "i" } },
          { category: { $regex: keyword, $options: "i" } }
        ]
      }
    ];
  }

  const cached = await ShopeeProduct.find(mongoQuery)
    .sort({ fetchedAt: -1, salesCount: -1, rating: -1 })
    .limit(limit)
    .lean();

  console.warn("[shopee/provider] using cached Shopee products after API failure", {
    reason,
    count: cached.length,
    sourceTag,
    hasKeyword: Boolean(query.keyword),
    hasCategory: Boolean(query.category)
  });

  return cached.map((product) => normalizeCachedShopeeProduct(product, sourceTag));
}

async function fetchShopeeAffiliateGraphqlProducts(input: {
  endpoint: string;
  appId: string;
  secret: string;
  query: ProductDiscoveryQuery;
}) {
  const primaryQuery = buildShopeeAffiliateGraphqlQuery(input.query);
  try {
    return await fetchShopeeAffiliateGraphqlProductsWithQuery({
      ...input,
      graphqlQuery: primaryQuery,
      queryMode: "primary"
    });
  } catch (error) {
    if (!(error instanceof ShopeeProviderError) || error.code !== "shopee_graphql_system_error") {
      throw error;
    }

    console.warn("[shopee/provider] retrying affiliate graphql with minimal query after system error", {
      sourceTag: input.query.sourceTag ?? "trending",
      hasKeyword: Boolean(input.query.keyword),
      hasCategory: Boolean(input.query.category)
    });

    try {
      return await fetchShopeeAffiliateGraphqlProductsWithQuery({
        ...input,
        graphqlQuery: buildShopeeAffiliateGraphqlFallbackQuery(input.query),
        queryMode: "minimal"
      });
    } catch (fallbackError) {
      if (fallbackError instanceof ShopeeProviderError && fallbackError.code === "shopee_graphql_system_error") {
        const cachedProducts = await fetchCachedShopeeProducts(input.query, "shopee_graphql_system_error");
        if (cachedProducts.length) {
          return cachedProducts;
        }
      }
      throw fallbackError;
    }
  }
}

async function fetchShopeeAffiliateGraphqlProductsWithQuery(input: {
  endpoint: string;
  appId: string;
  secret: string;
  query: ProductDiscoveryQuery;
  graphqlQuery: string;
  queryMode: "primary" | "minimal";
}) {
  const url = new URL(input.endpoint);
  const body = JSON.stringify({ query: input.graphqlQuery });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHash("sha256")
    .update(`${input.appId}${timestamp}${body}${input.secret}`)
    .digest("hex");
  const authorization = `SHA256 Credential=${input.appId}, Timestamp=${timestamp}, Signature=${signature}`;

  console.info("[shopee/provider] affiliate graphql product fetch", {
    endpointHost: url.host,
    endpointPath: url.pathname,
    sourceTag: input.query.sourceTag ?? "trending",
    hasKeyword: Boolean(input.query.keyword),
    hasCategory: Boolean(input.query.category),
    hasAppId: Boolean(input.appId),
    hasSecret: Boolean(input.secret),
    authMode: "affiliate_graphql",
    queryMode: input.queryMode,
    signatureGenerated: Boolean(signature),
    authorizationScheme: "SHA256"
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: authorization
    },
    body,
    cache: "no-store"
  });

  if (!response.ok) {
    const bodySummary = await summarizeResponse(response);
    console.warn("[shopee/provider] affiliate graphql product fetch failed", {
      endpointHost: url.host,
      endpointPath: url.pathname,
      status: response.status,
      bodySummary,
      authMode: "affiliate_graphql",
      queryMode: input.queryMode,
      signatureGenerated: Boolean(signature)
    });
    const message =
      response.status === 401
        ? "Shopee Affiliate API rejected the request. Set SHOPEE_AUTH_MODE=affiliate_graphql and verify AppID, Secret, endpoint region, timestamp, and SHA256 signature."
        : `Shopee Affiliate API request failed: ${response.status}`;
    throw new ShopeeProviderError(message, response.status, response.status === 401 ? "shopee_unauthorized" : "shopee_api_error", "shopee_api", bodySummary);
  }

  const payload = (await response.json()) as Record<string, any>;
  if (payload.errors?.length) {
    const summary = JSON.stringify(payload.errors).slice(0, 500);
    console.warn("[shopee/provider] affiliate graphql returned errors", {
      endpointHost: url.host,
      endpointPath: url.pathname,
      queryMode: input.queryMode,
      errorSummary: summary
    });
    const isSystemError = isShopeeGraphqlSystemError(payload);
    throw new ShopeeProviderError(
      isSystemError
        ? `Shopee Affiliate API system error on productOfferV2. The system will retry with a minimal query or cached products. Details: ${summary}`
        : `Shopee Affiliate API returned errors: ${summary}`,
      502,
      isSystemError ? "shopee_graphql_system_error" : "shopee_graphql_error",
      "shopee_api",
      summary
    );
  }

  const nodes =
    payload?.data?.productOfferV2?.nodes ??
    payload?.data?.productOfferV2?.products ??
    payload?.data?.productOfferV2?.items ??
    [];

  console.info("[shopee/provider] affiliate graphql product fetch completed", {
    endpointHost: url.host,
    endpointPath: url.pathname,
    queryMode: input.queryMode,
    productsCount: Array.isArray(nodes) ? nodes.length : 0
  });

  return (Array.isArray(nodes) ? nodes : []).map(mapExternalProduct(input.query.sourceTag ?? "trending"));
}

function mapExternalProduct(sourceTag: ShopeeSourceTag) {
  return (item: Record<string, unknown>): ShopeeProductRecord => {
    const productId = String(item.product_id ?? item.productId ?? item.item_id ?? crypto.randomUUID());
    const shopId = String(item.shop_id ?? item.shopId ?? "");
    const itemId = String(item.item_id ?? item.itemId ?? productId);
    return {
      productId,
      shopId,
      itemId,
      productName: String(item.product_name ?? item.name ?? item.productName ?? "Shopee Product"),
      productDescription: String(item.product_description ?? item.description ?? item.productDescription ?? ""),
      productPrice: Number(item.product_price ?? item.price ?? item.priceMin ?? item.price_min ?? 0),
      discountPrice: item.discount_price === undefined && item.priceMin === undefined ? undefined : Number(item.discount_price ?? item.priceMin),
      discountPercent: item.discount_percent === undefined ? undefined : Number(item.discount_percent),
      productImageUrl: String(item.product_image_url ?? item.image ?? item.productImageUrl ?? item.imageUrl ?? ""),
      productImageUrls: Array.isArray(item.product_image_urls)
        ? item.product_image_urls.map(String).filter(Boolean)
        : Array.isArray(item.images)
          ? item.images.map(String).filter(Boolean)
          : undefined,
      productUrl: String(item.product_url ?? item.url ?? item.productUrl ?? item.productLink ?? ""),
      affiliateUrl: item.affiliate_url || item.offerLink ? String(item.affiliate_url ?? item.offerLink) : undefined,
      category: String(item.category ?? item.categoryName ?? "General"),
      salesCount: item.sales_count === undefined && item.sales === undefined ? undefined : Number(item.sales_count ?? item.sales),
      reviewCount: item.review_count === undefined ? undefined : Number(item.review_count),
      shopName: item.shop_name === undefined && item.shopName === undefined ? undefined : String(item.shop_name ?? item.shopName),
      rating: item.rating === undefined && item.ratingStar === undefined ? undefined : Number(item.rating ?? item.ratingStar),
      commissionRate: item.commission_rate === undefined && item.commissionRate === undefined ? undefined : Number(item.commission_rate ?? item.commissionRate),
      sourceTag,
      fetchedAt: new Date()
    };
  };
}

export function getShopeeProductProvider(): ShopeeProductProvider {
  if (process.env.SHOPEE_PROVIDER?.trim().toLowerCase() === "mock") {
    return new MockShopeeProvider();
  }
  if (process.env.SHOPEE_AFFILIATE_API_URL) {
    return new ShopeeOfficialApiProvider();
  }
  return new MockShopeeProvider();
}

export function buildAffiliateLink(product: ShopeeProductRecord, trackingId?: string, subIds?: ShopeeSubIdFields) {
  const normalizedSubIds = validateShopeeSubIds(subIds ?? {});
  if (product.affiliateUrl && !hasAnyShopeeSubId(normalizedSubIds)) {
    return product.affiliateUrl;
  }

  const base = process.env.SHOPEE_AFFILIATE_BASE_URL?.trim();
  const resolvedTrackingId = trackingId?.trim() || process.env.SHOPEE_TRACKING_ID?.trim() || process.env.SHOPEE_AFFILIATE_ID?.trim();
  const sourceUrl = product.productUrl || `https://shopee.co.th/product/${product.shopId}/${product.itemId}`;
  const payload = buildShopeeAffiliatePayload({
    productUrl: sourceUrl,
    trackingId: resolvedTrackingId,
    subIds: normalizedSubIds
  });

  if (!base) {
    const url = new URL(sourceUrl);
    if (resolvedTrackingId) url.searchParams.set("utm_content", resolvedTrackingId);
    for (const [key, value] of Object.entries(payload)) {
      if (key !== "url" && value) url.searchParams.set(key, value);
    }
    url.searchParams.set("utm_source", "prosocial");
    url.searchParams.set("utm_medium", "affiliate_auto_post");
    return url.toString();
  }

  const url = new URL(base);
  for (const [key, value] of Object.entries(payload)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function isShopeeShortLink(value?: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "s.shopee.co.th" && url.pathname.length > 1;
  } catch {
    return false;
  }
}

async function fetchImageForAiEdit(url?: string) {
  if (!url) return null;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    return { bytes: await response.arrayBuffer(), mimeType: contentType };
  } catch {
    return null;
  }
}

function bufferToDataImageUrl(buffer: Buffer, mimeType = "image/png") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function getSafeHostname(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid-url";
  }
}

const TH = {
  note: "\u0e2b\u0e21\u0e32\u0e22\u0e40\u0e2b\u0e15\u0e38",
  affiliateReview: "\u0e23\u0e35\u0e27\u0e34\u0e27\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32",
  usefulItem: "\u0e02\u0e2d\u0e07\u0e19\u0e48\u0e32\u0e43\u0e0a\u0e49",
  interestedCta: "\u0e43\u0e04\u0e23\u0e2a\u0e19\u0e43\u0e08\u0e25\u0e2d\u0e07\u0e14\u0e39\u0e44\u0e14\u0e49\u0e04\u0e23\u0e31\u0e1a",
  detailsCta: "\u0e25\u0e2d\u0e07\u0e14\u0e39\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e44\u0e14\u0e49\u0e40\u0e25\u0e22",
  linkCta: "\u0e41\u0e1b\u0e30\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e44\u0e27\u0e49\u0e43\u0e2b\u0e49\u0e14\u0e49\u0e32\u0e19\u0e25\u0e48\u0e32\u0e07\u0e04\u0e23\u0e31\u0e1a",
  moreCta: "\u0e25\u0e2d\u0e07\u0e01\u0e14\u0e14\u0e39\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e40\u0e15\u0e34\u0e21\u0e44\u0e14\u0e49\u0e40\u0e25\u0e22",
  categoryPrefix: "\u0e2a\u0e32\u0e22 ",
  realUse: "\u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19\u0e08\u0e23\u0e34\u0e07",
  easyDetails: "\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e14\u0e39\u0e07\u0e48\u0e32\u0e22",
  approxPrice: "\u0e23\u0e32\u0e04\u0e32\u0e2d\u0e22\u0e39\u0e48\u0e1b\u0e23\u0e30\u0e21\u0e32\u0e13 ",
  baht: " \u0e1a\u0e32\u0e17",
  discountAbout: " \u0e15\u0e2d\u0e19\u0e19\u0e35\u0e49\u0e25\u0e14\u0e1b\u0e23\u0e30\u0e21\u0e32\u0e13 ",
  reviewFeelingStart: "\u0e1f\u0e35\u0e25\u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19\u0e14\u0e39\u0e07\u0e48\u0e32\u0e22 \u0e08\u0e31\u0e1a\u0e04\u0e39\u0e48\u0e01\u0e31\u0e1a\u0e0a\u0e35\u0e27\u0e34\u0e15\u0e1b\u0e23\u0e30\u0e08\u0e33\u0e27\u0e31\u0e19\u0e44\u0e14\u0e49\u0e14\u0e35",
  reviewFeelingEnd: " \u0e14\u0e39\u0e40\u0e1b\u0e47\u0e19\u0e02\u0e2d\u0e07\u0e17\u0e35\u0e48\u0e2b\u0e22\u0e34\u0e1a\u0e21\u0e32\u0e43\u0e0a\u0e49\u0e44\u0e14\u0e49\u0e08\u0e23\u0e34\u0e07 \u0e44\u0e21\u0e48\u0e14\u0e39\u0e40\u0e22\u0e2d\u0e30\u0e40\u0e01\u0e34\u0e19\u0e44\u0e1b \uD83D\uDC4D",
  discountBullet: "- \u0e2a\u0e48\u0e27\u0e19\u0e25\u0e14\u0e1b\u0e23\u0e30\u0e21\u0e32\u0e13 ",
  categoryBullet: "- \u0e40\u0e2b\u0e21\u0e32\u0e30\u0e01\u0e31\u0e1a\u0e2b\u0e21\u0e27\u0e14 ",
  useCaseBullet: "- \u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19\u0e07\u0e48\u0e32\u0e22 \u0e40\u0e2b\u0e21\u0e32\u0e30\u0e01\u0e31\u0e1a\u0e43\u0e0a\u0e49\u0e43\u0e19\u0e0a\u0e35\u0e27\u0e34\u0e15\u0e1b\u0e23\u0e30\u0e08\u0e33\u0e27\u0e31\u0e19",
  materialBullet: "- \u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e14\u0e39\u0e04\u0e38\u0e49\u0e21\u0e17\u0e35\u0e40\u0e14\u0e35\u0e22\u0e27 \u0e2b\u0e22\u0e34\u0e1a\u0e43\u0e0a\u0e49\u0e44\u0e14\u0e49\u0e2b\u0e25\u0e32\u0e22\u0e42\u0e2d\u0e01\u0e32\u0e2a",
  defaultProductName: "\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32 Shopee \u0e17\u0e35\u0e48\u0e19\u0e48\u0e32\u0e2a\u0e19\u0e43\u0e08"
};

const SHOPEE_HARD_SELL_PATTERNS = [
  /à¸ªà¸´à¸™à¸„à¹‰à¸²à¸„à¸¸à¸“à¸ à¸²à¸žà¸”à¸µ/gi,
  /à¹‚à¸›à¸£à¹‚à¸¡à¸Šà¸±à¹ˆà¸™à¸ªà¸¸à¸”à¸„à¸¸à¹‰à¸¡/gi,
  /à¸£à¸µà¸šà¸ªà¸±à¹ˆà¸‡à¸‹à¸·à¹‰à¸­/gi,
  /à¸£à¸µà¸šà¸‹à¸·à¹‰à¸­à¸”à¹ˆà¸§à¸™/gi,
  /à¹‚à¸›à¸£à¹‚à¸¡à¸Šà¸±à¹ˆà¸™à¸«à¹‰à¸²à¸¡à¸žà¸¥à¸²à¸”/gi,
  /à¸£à¸µà¸šà¸à¸”à¸à¹ˆà¸­à¸™à¸«à¸¡à¸”/gi,
  /à¸‚à¸­à¸‡à¸¡à¸±à¸™à¸•à¹‰à¸­à¸‡à¸¡à¸µ/gi,
  /à¸‹à¸·à¹‰à¸­à¹€à¸¥à¸¢à¸•à¸­à¸™à¸™à¸µà¹‰/gi,
  /à¸žà¸¥à¸²à¸”à¹„à¸¡à¹ˆà¹„à¸”à¹‰/gi,
  /à¸¥à¸”à¸à¸£à¸°à¸«à¸™à¹ˆà¸³/gi,
  /à¸„à¸¸à¹‰à¸¡à¸ªà¸¸à¸”/gi,
  /à¸‚à¸²à¸¢à¸”à¸µà¸­à¸±à¸™à¸”à¸±à¸š\s*1/gi,
  /à¸ªà¸´à¸™à¸„à¹‰à¸²à¸‚à¸²à¸¢à¸”à¸µà¸—à¸µà¹ˆà¸ªà¸¸à¸”/gi,
  /à¸«à¹‰à¸²à¸¡à¸žà¸¥à¸²à¸”/gi
];

const SHOPEE_FORBIDDEN_OPENERS = [
  /^à¹€à¸‚à¹‰à¸²à¹ƒà¸ˆà¹à¸¥à¹‰à¸§à¸§à¹ˆà¸²à¸—à¸³à¹„à¸¡/i,
  /^à¸•à¸­à¸™à¹à¸£à¸à¸„à¸´à¸”à¸§à¹ˆà¸²/i,
  /^à¸•à¸­à¸™à¹à¸£à¸à¹„à¸¡à¹ˆà¹„à¸”à¹‰/i,
  /^à¸­à¸±à¸™à¸™à¸µà¹‰à¸„à¸·à¸­/i,
  /^à¹€à¸«à¹‡à¸™à¸„à¸™à¸£à¸µà¸§à¸´à¸§à¹€à¸¢à¸­à¸°/i,
  /^à¹ƒà¸Šà¹‰à¹à¸¥à¹‰à¸§à¹€à¸‚à¹‰à¸²à¹ƒà¸ˆà¹€à¸¥à¸¢/i,
  /^à¸‚à¸­à¸‡à¸ˆà¸£à¸´à¸‡à¸ªà¸§à¸¢à¸à¸§à¹ˆà¸²/i,
  /^à¹‚à¸„à¸•à¸£à¹€à¸«à¸¡à¸²à¸°à¸à¸±à¸š/i,
  /^à¹ƒà¸„à¸£à¸à¸³à¸¥à¸±à¸‡à¸«à¸².*à¸¥à¸­à¸‡à¸”à¸¹à¸•à¸±à¸§à¸™à¸µà¹‰à¸à¹ˆà¸­à¸™/i,
  /^Stop scrolling/i,
  /^Here are Shopee finds/i
];

const SHOPEE_SOFT_CTAS = [
  "ðŸ›’ à¸à¸”à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡",
  "ðŸ“Œ à¸”à¸¹à¸£à¸²à¸„à¸²à¹à¸¥à¸°à¹‚à¸›à¸£à¸¥à¹ˆà¸²à¸ªà¸¸à¸”",
  "âœ¨ à¹€à¸‚à¹‰à¸²à¹„à¸›à¸”à¸¹à¸£à¸µà¸§à¸´à¸§à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡à¹„à¸”à¹‰à¹€à¸¥à¸¢",
  "ðŸŽ¯ à¹€à¸œà¸·à¹ˆà¸­à¸à¸³à¸¥à¸±à¸‡à¸¡à¸­à¸‡à¸«à¸²à¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸™à¸§à¸™à¸µà¹‰à¸­à¸¢à¸¹à¹ˆ",
  "ðŸ’¥ à¸¥à¸­à¸‡à¸à¸”à¹€à¸‚à¹‰à¸²à¹„à¸›à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¸à¹ˆà¸­à¸™à¸•à¸±à¸”à¸ªà¸´à¸™à¹ƒà¸ˆ",
  "ðŸ›’ à¸à¸”à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡à¹„à¸”à¹‰à¸—à¸µà¹ˆ",
  "ðŸ“Œ à¸”à¸¹à¸£à¸²à¸„à¸²à¹à¸¥à¸°à¹‚à¸›à¸£à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸—à¸µà¹ˆà¸¥à¸´à¸‡à¸à¹Œà¸”à¹‰à¸²à¸™à¸¥à¹ˆà¸²à¸‡",
  "âœ¨ à¸¥à¸­à¸‡à¹€à¸‚à¹‰à¸²à¹„à¸›à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¸à¹ˆà¸­à¸™à¸•à¸±à¸”à¸ªà¸´à¸™à¹ƒà¸ˆà¹„à¸”à¹‰à¹€à¸¥à¸¢",
  "ðŸŽ¯ à¹€à¸œà¸·à¹ˆà¸­à¸à¸³à¸¥à¸±à¸‡à¸«à¸²à¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸™à¸§à¸™à¸µà¹‰à¸­à¸¢à¸¹à¹ˆ à¸¥à¸­à¸‡à¸”à¸¹à¹„à¸”à¹‰à¸„à¸£à¸±à¸š",
  TH.interestedCta,
  TH.detailsCta,
  TH.linkCta,
  TH.moreCta,
  "à¹ƒà¸„à¸£à¸ªà¸™à¹ƒà¸ˆà¸¥à¸­à¸‡à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¹„à¸”à¹‰à¸„à¸£à¸±à¸š"
];

const SHOPEE_HASHTAG_FALLBACKS = ["#Shopee", "#à¸‚à¸­à¸‡à¹ƒà¸Šà¹‰à¸”à¸µà¸šà¸­à¸à¸•à¹ˆà¸­"];

const SHOPEE_GENERIC_CATEGORY_TERMS = new Set([
  "general",
  "lifestyle",
  "beauty",
  "home",
  "category",
  "product",
  "products",
  "misc",
  "other",
  "others",
  "à¸—à¸±à¹ˆà¸§à¹„à¸›",
  "à¹„à¸¥à¸Ÿà¹Œà¸ªà¹„à¸•à¸¥à¹Œ",
  "à¸„à¸§à¸²à¸¡à¸‡à¸²à¸¡",
  "à¸«à¸¡à¸§à¸”à¸«à¸¡à¸¹à¹ˆ",
  "à¸ªà¸´à¸™à¸„à¹‰à¸²",
  "à¸šà¹‰à¸²à¸™"
]);

const SHOPEE_FORBIDDEN_HASHTAGS = new Set([
  "#General",
  "#Lifestyle",
  "#Beauty",
  "#Home",
  "#Category",
  "#Product",
  "#Products"
]);

const SHOPEE_MARKETPLACE_METRIC_PATTERNS = [
  /à¸„à¸°à¹à¸™à¸™à¸£à¹‰à¸²à¸™/iu,
  /à¸£à¹‰à¸²à¸™à¹„à¸”à¹‰à¸„à¸°à¹à¸™à¸™/iu,
  /à¸„à¸°à¹à¸™à¸™à¸£à¸µà¸§à¸´à¸§/iu,
  /à¸ˆà¸³à¸™à¸§à¸™à¸£à¸µà¸§à¸´à¸§/iu,
  /à¸¢à¸­à¸”à¸‚à¸²à¸¢/iu,
  /à¸‚à¸²à¸¢à¹à¸¥à¹‰à¸§/iu,
  /à¸‚à¸²à¸¢à¹„à¸›à¹à¸¥à¹‰à¸§/iu,
  /à¸‚à¸²à¸¢à¸”à¸µà¸­à¸±à¸™à¸”à¸±à¸š/iu,
  /à¸­à¸±à¸™à¸”à¸±à¸š\s*1/iu,
  /bestseller/iu,
  /best\s*seller/iu,
  /review count/iu,
  /sales count/iu,
  /rating/iu
];

function randomText(items: string[]) {
  return items[Math.floor(Math.random() * items.length)] ?? items[0] ?? "";
}

function compactProductText(value?: string, max = 92) {
  const normalized = (value ?? "").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? normalized.slice(0, max).replace(/\s+\S*$/, "") + "..." : normalized;
}

function normalizeProductNameText(value?: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*_()[\]{}"'`~|\\/.,:;!?+=<>\-â€“â€”]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getProductNameTokens(productName?: string) {
  return normalizeProductNameText(productName)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !isGenericShopeeCategoryText(token));
}

export function isSimilarToShopeeProductName(value: string | undefined, productName: string | undefined, threshold = 0.7) {
  const normalizedValue = normalizeProductNameText(value);
  const normalizedName = normalizeProductNameText(productName);
  if (!normalizedValue || !normalizedName) return false;
  if (normalizedValue === normalizedName) return true;
  if (normalizedName.length >= 12 && normalizedValue.includes(normalizedName)) return true;

  const nameTokens = getProductNameTokens(productName);
  if (!nameTokens.length) return false;
  const valueTokens = new Set(normalizedValue.split(/\s+/).filter(Boolean));
  const matched = nameTokens.filter((token) => valueTokens.has(token)).length;
  return matched / nameTokens.length >= threshold;
}

function removeShopeeProductNameFromText(value: string, productName?: string) {
  const normalizedName = normalizeProductNameText(productName);
  if (!value.trim() || !normalizedName) return value.trim();

  let cleaned = value.trim();
  const productNameTokens = getProductNameTokens(productName).sort((a, b) => b.length - a.length);
  for (const token of productNameTokens) {
    if (token.length < 3) continue;
    cleaned = cleaned.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  }
  return cleaned
    .replace(/\s+/g, " ")
    .replace(/^[\s:ï¼š,\-â€“â€”|/]+|[\s:ï¼š,\-â€“â€”|/]+$/g, "")
    .trim();
}

export function countShopeeProductNameMentions(caption: string, productName?: string) {
  const normalizedName = normalizeProductNameText(productName);
  if (!caption.trim() || !normalizedName) return 0;
  const lines = caption
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((part) => part && !isShopeeProductNameDuplicateText(part, productName || ""));
  return lines.filter((line) => isSimilarToShopeeProductName(line, productName)).length;
}

function stripDuplicateShopeeProductNameLines(lines: string[], productName?: string) {
  if (!productName) return lines;
  let productNameUsed = false;
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }

    const isProductNameLike = isSimilarToShopeeProductName(trimmed, productName);
    if (!isProductNameLike) {
      output.push(line);
      continue;
    }

    if (!productNameUsed) {
      output.push(compactProductText(productName, 120));
      productNameUsed = true;
      continue;
    }

    const remainder = removeShopeeProductNameFromText(trimmed, productName);
    if (remainder.length >= 6 && !isSimilarToShopeeProductName(remainder, productName, 0.5)) {
      output.push(remainder);
    }
  }

  return output;
}

function stripForbiddenAffiliateDisclosure(caption: string) {
  return caption
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().toLowerCase();
      if (!normalized) return true;
      return !normalized.includes(TH.note) && !normalized.includes("affiliate");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeHardSellPhrases(caption: string) {
  return SHOPEE_HARD_SELL_PATTERNS.reduce((value, pattern) => value.replace(pattern, ""), caption)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeMarketplaceMetricLines(caption: string) {
  return caption
    .split(/\r?\n/)
    .filter((line) => !SHOPEE_MARKETPLACE_METRIC_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHashtagToken(value: string) {
  const cleaned = value.replace(/^#+/, "").replace(/[^\p{L}\p{N}_-]/gu, "").trim();
  return cleaned ? "#" + cleaned : "";
}

function isGenericShopeeCategoryText(value?: string) {
  const normalized = (value ?? "")
    .replace(/^#+/, "")
    .replace(/[\s_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return SHOPEE_GENERIC_CATEGORY_TERMS.has(normalized);
}

function isForbiddenShopeeHashtag(tag: string) {
  if (!tag) return true;
  if (SHOPEE_FORBIDDEN_HASHTAGS.has(tag)) return true;
  return isGenericShopeeCategoryText(tag);
}

function buildRelevantShopeeHashtags(product: ShopeeProductRecord) {
  const titleTokens = product.productName
    .split(/[\s/|,()[\]{}]+/)
    .map((part) => part.replace(/[^\p{L}\p{N}_-]/gu, "").trim())
    .filter((part) => part.length >= 3 && !isGenericShopeeCategoryText(part))
    .slice(0, 3);

  const candidates = [...titleTokens, "Shopee"].filter(Boolean);
  const tags = candidates
    .map((item) => normalizeHashtagToken(String(item ?? "")))
    .filter((tag) => tag && !isForbiddenShopeeHashtag(tag));

  return Array.from(new Set(tags)).slice(0, SHOPEE_MAX_HASHTAGS);
}

function extractHashtags(lines: string[], product?: ShopeeProductRecord) {
  const tags: string[] = [];
  const contentLines: string[] = [];
  for (const line of lines) {
    const matches = line.match(/#[^\s#]+/g) ?? [];
    if (matches.length) tags.push(...matches.map(normalizeHashtagToken).filter((tag) => tag && !isForbiddenShopeeHashtag(tag)));
    const withoutTags = line.replace(/#[^\s#]+/g, "").trim();
    if (withoutTags) contentLines.push(withoutTags);
  }
  const fallback = product ? buildRelevantShopeeHashtags(product) : SHOPEE_HASHTAG_FALLBACKS;
  return {
    contentLines,
    hashtags: Array.from(new Set([...tags, ...fallback].filter((tag) => tag && !isForbiddenShopeeHashtag(tag)))).slice(0, SHOPEE_MAX_HASHTAGS)
  };
}

function hasSoftCta(caption: string) {
  return /(à¸¥à¸­à¸‡à¸”à¸¹|à¸ªà¸™à¹ƒà¸ˆ|à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”|à¸¥à¸´à¸‡à¸à¹Œ|à¸¥à¸´à¸‡à¸„à¹Œ|à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡|à¸”à¹‰à¸²à¸™à¸¥à¹ˆà¸²à¸‡|à¸à¸”à¸”à¸¹|à¸žà¸´à¸à¸±à¸”|à¸£à¸²à¸„à¸²|à¹‚à¸›à¸£à¸¥à¹ˆà¸²à¸ªà¸¸à¸”|Shopee|shopee|à¸”à¸¹à¹„à¸”à¹‰|à¸”à¸¹à¸•à¸±à¸§à¸™à¸µà¹‰|à¹„à¸”à¹‰à¸—à¸µà¹ˆ)/i.test(caption);
}

function formatShopeePrice(product?: ShopeeProductRecord) {
  const price = product?.discountPrice || product?.productPrice;
  if (!price || !Number.isFinite(price)) return "";
  return `ðŸ’° à¸£à¸²à¸„à¸²à¹‚à¸›à¸£ ${new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(price)} à¸šà¸²à¸—`;
}

function isCategoryLikeShopeeFeature(value?: string, product?: ShopeeProductRecord) {
  const cleaned = (value ?? "")
    .replace(/^[*â€¢\-âœ…\s]+/, "")
    .replace(/^#+/, "")
    .replace(/^(à¹€à¸«à¸¡à¸²à¸°à¸à¸±à¸šà¸«à¸¡à¸§à¸”|à¸«à¸¡à¸§à¸”|category|à¸«à¸¡à¸§à¸”à¸«à¸¡à¸¹à¹ˆ)\s*[:ï¼š]?\s*/i, "")
    .trim();
  if (!cleaned) return true;
  if (/^(à¹€à¸«à¸¡à¸²à¸°à¸à¸±à¸šà¸«à¸¡à¸§à¸”|à¸«à¸¡à¸§à¸”|category|general|lifestyle|beauty|home|product)$/i.test(cleaned)) return true;
  if (isGenericShopeeCategoryText(cleaned)) return true;
  if (product?.category && cleaned.toLowerCase() === product.category.trim().toLowerCase()) return true;
  return false;
}

function normalizeShopeeBullet(value: string, max = 86, product?: ShopeeProductRecord) {
  const cleaned = compactProductText(
    value
      .replace(/^[*â€¢\-âœ…\s]+/, "")
      .replace(/^(à¸ˆà¸¸à¸”à¹€à¸”à¹ˆà¸™|à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”|feature|detail)\s*[:ï¼š]?\s*/i, "")
      .trim(),
    max
  );
  if (!cleaned) return "";
  if (SHOPEE_MARKETPLACE_METRIC_PATTERNS.some((pattern) => pattern.test(cleaned))) return "";
  if (isCategoryLikeShopeeFeature(cleaned, product)) return "";
  return `âœ… ${cleaned}`;
}

function stringifyShopeeMetadataValue(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringifyShopeeMetadataValue);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => {
        if (entry === undefined || entry === null) return [];
        if (typeof entry === "object") return stringifyShopeeMetadataValue(entry);
        return [`${key}: ${String(entry)}`];
      })
      .filter(Boolean);
  }
  return [];
}

function rotateShopeeFacts(items: string[], product: ShopeeProductRecord) {
  if (items.length <= 1) return items;
  const seed = `${product.productId || product.itemId || product.productName}:${new Date().getDate()}`;
  const offset = Math.abs(seed.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function collectShopeeProductFacts(product: ShopeeProductRecord) {
  const record = product as ShopeeProductRecord & Record<string, unknown>;
  const productName = product.productName || "";
  const descriptionParts = (product.productDescription || "")
    .split(/\r?\n|[.!?ã€‚]|[à¸¯à¹†]/)
    .map((part) => compactProductText(part, 86))
    .filter((part): part is string => Boolean(part) && !isShopeeProductNameDuplicateText(part, productName));
  const metadataParts = ["productFeatures", "features", "specifications", "specs", "attributes", "variants"]
    .flatMap((key) => stringifyShopeeMetadataValue(record[key]))
    .map((part) => compactProductText(part, 86))
    .filter((part): part is string => Boolean(part) && !isShopeeProductNameDuplicateText(part, productName));

  const facts = Array.from(
    new Set(
      [...descriptionParts, ...metadataParts]
        .map((item) => normalizeShopeeBullet(stripShopeeProductNameFromText(item, productName), 86, product))
        .filter((item): item is string => Boolean(item) && !isShopeeProductNameDuplicateText(item, productName))
    )
  );

  return rotateShopeeFacts(facts, product).slice(0, Math.min(4, facts.length));
}

function formatShopeeShortLinkLine(shopeeShortUrl: string) {
  return `ðŸ“ à¸žà¸´à¸à¸±à¸” ${shopeeShortUrl}`;
}

function removeOldShopeeHookLines(lines: string[]) {
  return lines.filter((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (index > 2) return true;
    return !SHOPEE_FORBIDDEN_OPENERS.some((pattern) => pattern.test(trimmed));
  });
}

function stripShopeeLeadingEmoji(value: string) {
  return value.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function buildShopeeProductHook(product: ShopeeProductRecord) {
  const haystack = `${product.productName} ${product.productDescription || ""}`.toLowerCase();
  if (/à¹„à¸«à¸¡à¸‚à¸±à¸”à¸Ÿà¸±à¸™|floss|dental|à¸Šà¹ˆà¸­à¸‡à¸›à¸²à¸|à¸Ÿà¸±à¸™/.test(haystack)) return randomText(["à¸‹à¸·à¹‰à¸­à¸„à¸£à¸±à¹‰à¸‡à¹€à¸”à¸µà¸¢à¸§à¹ƒà¸Šà¹‰à¹„à¸”à¹‰à¸™à¸²à¸™à¸«à¸¥à¸²à¸¢à¹€à¸”à¸·à¸­à¸™", "à¸à¸¥à¸²à¸¢à¹€à¸›à¹‡à¸™à¸‚à¸­à¸‡à¸—à¸µà¹ˆà¸«à¸¢à¸´à¸šà¹ƒà¸Šà¹‰à¸—à¸¸à¸à¸§à¸±à¸™"]);
  if (/à¸à¸²à¸‡à¹€à¸à¸‡|short|sportswear|à¸§à¸´à¹ˆà¸‡|à¸à¸µà¸¬à¸²|à¸Ÿà¸´à¸•à¹€à¸™à¸ª/.test(haystack)) return randomText(["à¹ƒà¸ªà¹ˆà¸§à¸´à¹ˆà¸‡à¹à¸¥à¹‰à¸§à¸„à¸¥à¹ˆà¸­à¸‡à¸•à¸±à¸§à¸à¸§à¹ˆà¸²à¸—à¸µà¹ˆà¸„à¸´à¸”", "à¸œà¹‰à¸²à¹€à¸šà¸²à¸ˆà¸™à¹à¸—à¸šà¹„à¸¡à¹ˆà¸£à¸¹à¹‰à¸ªà¸¶à¸à¸§à¹ˆà¸²à¹ƒà¸ªà¹ˆ"]);
  if (/à¹à¸à¹‰à¸§|tumbler|à¹€à¸à¹‡à¸šà¸„à¸§à¸²à¸¡à¹€à¸¢à¹‡à¸™|à¸™à¹‰à¸³à¹à¸‚à¹‡à¸‡|à¸‚à¸§à¸”à¸™à¹‰à¸³/.test(haystack)) return randomText(["à¸™à¹‰à¸³à¹à¸‚à¹‡à¸‡à¸¢à¸±à¸‡à¸­à¸¢à¸¹à¹ˆà¸«à¸¥à¸±à¸‡à¹€à¸¥à¸´à¸à¸‡à¸²à¸™", "à¸žà¸à¸­à¸­à¸à¹„à¸›à¸—à¸±à¹‰à¸‡à¸§à¸±à¸™à¹à¸¥à¹‰à¸§à¸¢à¸±à¸‡à¹€à¸¢à¹‡à¸™à¸­à¸¢à¸¹à¹ˆ"]);
  if (/à¸à¸£à¸°à¹€à¸›à¹‹à¸²|bag|à¹€à¸›à¹‰|à¸„à¸²à¸”à¸­à¸|wallet/.test(haystack)) return randomText(["à¸Šà¹ˆà¸­à¸‡à¹€à¸à¹‡à¸šà¸‚à¸­à¸‡à¹€à¸¢à¸­à¸°à¸à¸§à¹ˆà¸²à¸—à¸µà¹ˆà¸„à¸´à¸”", "à¸«à¸¢à¸´à¸šà¸‚à¸­à¸‡à¸‡à¹ˆà¸²à¸¢à¸‚à¸¶à¹‰à¸™à¹€à¸§à¸¥à¸²à¸­à¸­à¸à¸ˆà¸²à¸à¸šà¹‰à¸²à¸™"]);
  if (/à¸žà¸±à¸”à¸¥à¸¡|fan|à¸£à¸°à¸šà¸²à¸¢à¸­à¸²à¸à¸²à¸¨/.test(haystack)) return randomText(["à¸­à¸²à¸à¸²à¸¨à¸£à¹‰à¸­à¸™ à¹† à¸žà¸à¹„à¸§à¹‰à¸„à¸·à¸­à¸Šà¹ˆà¸§à¸¢à¹„à¸”à¹‰à¹€à¸¢à¸­à¸°", "à¸¥à¸¡à¹à¸£à¸‡à¸à¸§à¹ˆà¸²à¸‚à¸™à¸²à¸”à¸—à¸µà¹ˆà¹€à¸«à¹‡à¸™à¸ˆà¸£à¸´à¸‡"]);
  if (/à¸£à¸­à¸‡à¹€à¸—à¹‰à¸²|shoe|sneaker|à¹à¸•à¸°/.test(haystack)) return randomText(["à¹ƒà¸ªà¹ˆà¹€à¸”à¸´à¸™à¸—à¸±à¹‰à¸‡à¸§à¸±à¸™à¹à¸¥à¹‰à¸§à¸¢à¸±à¸‡à¸ªà¸šà¸²à¸¢à¹€à¸—à¹‰à¸²", "à¹à¸¡à¸•à¸Šà¹Œà¸Šà¸¸à¸”à¸‡à¹ˆà¸²à¸¢à¸à¸§à¹ˆà¸²à¸—à¸µà¹ˆà¸„à¸´à¸”"]);

  const fact = stripShopeeLeadingEmoji(collectShopeeProductFacts(product)[0] || "");
  return fact ? compactProductText(`${fact} à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¸ˆà¸£à¸´à¸‡à¹à¸¥à¹‰à¸§à¸£à¸¹à¹‰à¸ªà¸¶à¸à¹„à¸”à¹‰`, 90) : "à¹€à¸¥à¸·à¸­à¸à¸ˆà¸²à¸à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¹‰à¸§à¸”à¸¹à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¹„à¸”à¹‰à¸ˆà¸£à¸´à¸‡";
}

function buildShopeeReviewFeeling(product: ShopeeProductRecord) {
  const facts = collectShopeeProductFacts(product).map((line) => stripShopeeLeadingEmoji(line));
  const primaryFact = facts[0] || "à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¸‡à¹ˆà¸²à¸¢à¹ƒà¸™à¸Šà¸µà¸§à¸´à¸•à¸›à¸£à¸°à¸ˆà¸³à¸§à¸±à¸™";
  const templates = [
    `${primaryFact} à¸Ÿà¸µà¸¥à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¸ˆà¸£à¸´à¸‡à¸„à¹ˆà¸­à¸™à¸‚à¹‰à¸²à¸‡à¹‚à¸­à¹€à¸„ à¹€à¸«à¸¡à¸²à¸°à¸à¸±à¸šà¸«à¸¢à¸´à¸šà¹ƒà¸Šà¹‰à¸šà¹ˆà¸­à¸¢ à¹†`,
    `à¸ˆà¸¸à¸”à¸—à¸µà¹ˆà¸Šà¸­à¸šà¸„à¸·à¸­ ${primaryFact} à¹ƒà¸Šà¹‰à¹à¸¥à¹‰à¸§à¸£à¸¹à¹‰à¸ªà¸¶à¸à¸§à¹ˆà¸²à¸ªà¸°à¸”à¸§à¸à¸‚à¸¶à¹‰à¸™`,
    `${primaryFact} à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¸”à¸¹à¸•à¸­à¸šà¹‚à¸ˆà¸—à¸¢à¹Œà¸„à¸™à¸—à¸µà¹ˆà¸­à¸¢à¸²à¸à¹„à¸”à¹‰à¸‚à¸­à¸‡à¹ƒà¸Šà¹‰à¹à¸šà¸šà¹„à¸¡à¹ˆà¸¢à¸¸à¹ˆà¸‡à¸¢à¸²à¸`
  ];
  return compactProductText(randomText(templates), 170);
}

function buildShopeeDetailBullets(product: ShopeeProductRecord) {
  return collectShopeeProductFacts(product).slice(0, 4);
}

export function buildShopeeFallbackCaption(product: ShopeeProductRecord, shopeeShortUrl: string) {
  return sanitizeShopeeCaption(
    [
      product.productName,
      "",
      buildShopeeProductHook(product),
      "",
      `âœ¨ ${buildShopeeReviewFeeling(product)}`,
      "",
      "ðŸ“Œ à¸ˆà¸¸à¸”à¹€à¸”à¹ˆà¸™à¸—à¸µà¹ˆà¸Šà¸­à¸š",
      "",
      ...buildShopeeDetailBullets(product),
      "",
      formatShopeePrice(product),
      "",
      "ðŸ›’ à¸à¸”à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡",
      "",
      formatShopeeShortLinkLine(shopeeShortUrl),
      "",
      buildRelevantShopeeHashtags(product).join(" ")
    ].join("\n"),
    shopeeShortUrl,
    product
  );
}

export function sanitizeShopeeCaption(caption: string, shopeeShortUrl: string, product?: ShopeeProductRecord) {
  const cleanedCaption = removeMarketplaceMetricLines(removeHardSellPhrases(stripForbiddenAffiliateDisclosure(caption)))
    .replace(/https?:\/\/prosocial-app-theta\.vercel\.app\/\S+/gi, "")
    .replace(/https?:\/\/[^\s]*\/api\/s\/\S+/gi, "")
    .replace(/(?:â”{3,}|[-=]{3,})/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const rawLines = cleanedCaption
    .replace(/https?:\/\/[^\s]+/gi, (match) => (isShopeeShortLink(match) ? shopeeShortUrl : ""))
    .replace(/à¸«à¸¡à¸²à¸¢à¹€à¸«à¸•à¸¸[^\n]*/gi, "")
    .replace(/affiliate/gi, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.includes(shopeeShortUrl) &&
        !/^Shopee\s*Link\s*:/i.test(line) &&
        !/^(?:ðŸ“\s*)?à¸žà¸´à¸à¸±à¸”/i.test(line) &&
        !/^âœ¨\s*à¸„à¸§à¸²à¸¡à¸£à¸¹à¹‰à¸ªà¸¶à¸à¸«à¸¥à¸±à¸‡à¹ƒà¸Šà¹‰à¸‡à¸²à¸™/i.test(line) &&
        !/^ðŸ›’\s*à¸à¸”à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”/i.test(line) &&
        !/^(?:ðŸ’°\s*)?à¸£à¸²à¸„à¸²(à¹‚à¸›à¸£)?\s*/i.test(line)
    );

  const noOldHooks = removeOldShopeeHookLines(rawLines);
  const { contentLines, hashtags } = extractHashtags(noOldHooks, product);
  const productName = compactProductText(product?.productName?.trim() || contentLines[0] || TH.defaultProductName, 120);
  const deDuplicatedContentLines = removeDuplicateShopeeProductNameLines(contentLines, productName);
  const safeHashtags = hashtags
    .filter((tag) => !isShopeeProductNameDuplicateText(tag.replace(/^#/, ""), productName))
    .slice(0, SHOPEE_MAX_HASHTAGS);
  const bodyLines = deDuplicatedContentLines
    .filter((line) => line !== productName && !isShopeeProductNameDuplicateText(line, productName))
    .slice(0, 10);
  const isBullet = (line: string) => /^[*â€¢\-âœ…]/.test(line);

  const aiReviewLine = bodyLines.find((line) => !isBullet(line) && !hasSoftCta(line) && !isCategoryLikeShopeeFeature(line, product) && !isShopeeProductNameDuplicateText(line, productName));
  const reviewLine = stripShopeeLeadingEmoji(
    compactProductText(aiReviewLine || buildShopeeReviewFeeling(product ?? ({ productName } as ShopeeProductRecord)), 170)
  );
  const aiBullets = bodyLines
    .map((line) => (isBullet(line) ? normalizeShopeeBullet(stripShopeeProductNameFromText(line, productName), 86, product) : ""))
    .filter((line): line is string => Boolean(line) && !isShopeeProductNameDuplicateText(line, productName));
  const fallbackBullets = product ? buildShopeeDetailBullets(product).filter((line) => !isShopeeProductNameDuplicateText(line, productName)) : [];
  const details = Array.from(new Set([...aiBullets, ...fallbackBullets])).filter((line) => !isShopeeProductNameDuplicateText(line, productName)).slice(0, 4);
  const rawHookLine = product ? buildShopeeProductHook(product) : compactProductText(bodyLines.find((line) => !isBullet(line)) || "เลือกจากรายละเอียดสินค้าแล้วดูใช้งานได้จริง", 90);
  const hookLine = isShopeeProductNameDuplicateText(rawHookLine, productName)
    ? stripShopeeProductNameFromText(rawHookLine, productName) || buildShopeeReviewFeeling(product ?? ({ productName } as ShopeeProductRecord))
    : rawHookLine;
  const priceLine = formatShopeePrice(product);
  const ctaLine = "ðŸ›’ à¸à¸”à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡";
  const spacedDetails = details.flatMap((line) => [line, ""]).slice(0, -1);

  const finalLines = [
    productName,
    "",
    hookLine,
    "",
    `âœ¨ ${reviewLine}`,
    "",
    "ðŸ“Œ à¸ˆà¸¸à¸”à¹€à¸”à¹ˆà¸™à¸—à¸µà¹ˆà¸Šà¸­à¸š",
    "",
    ...spacedDetails,
    ...(priceLine ? ["", priceLine] : []),
    "",
    ctaLine,
    "",
    formatShopeeShortLinkLine(shopeeShortUrl),
    "",
    safeHashtags.join(" ")
  ];

  const normalizedCaption = finalLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  if (normalizedCaption.length <= 700) {
    return normalizedCaption;
  }

  const compactDetails = details.slice(0, 3).map((line) => normalizeShopeeBullet(line, 72, product)).filter(Boolean);
  const compactSpacedDetails = compactDetails.flatMap((line) => [line, ""]).slice(0, -1);

  return [
    productName,
    "",
    compactProductText(hookLine, 80),
    "",
    `âœ¨ ${compactProductText(reviewLine, 120)}`,
    "",
    "ðŸ“Œ à¸ˆà¸¸à¸”à¹€à¸”à¹ˆà¸™à¸—à¸µà¹ˆà¸Šà¸­à¸š",
    "",
    ...compactSpacedDetails,
    ...(priceLine ? ["", priceLine] : []),
    "",
    ctaLine,
    "",
    formatShopeeShortLinkLine(shopeeShortUrl),
    "",
    safeHashtags.join(" ")
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export async function createOrReuseAffiliateShortLink(input: {
  userId: string;
  product: ShopeeProductRecord;
  trackingId?: string;
  subIds?: ShopeeSubIdFields;
  pageId?: string;
}) {
  const trackingId = input.trackingId?.trim() || process.env.SHOPEE_TRACKING_ID?.trim() || "default";
  const subIds = validateShopeeSubIds(input.subIds ?? {});
  const originalUrl = input.product.productUrl || `https://shopee.co.th/product/${input.product.shopId}/${input.product.itemId}`;
  const affiliateUrl = buildAffiliateLink(input.product, trackingId, subIds);

  if (!affiliateUrl) {
    throw new ShopeeProviderError("Affiliate link generation failed", 500, "shopee_affiliate_link_failed", "config");
  }
  if (!isShopeeShortLink(affiliateUrl)) {
    throw new ShopeeProviderError(
      `Shopee short link validation failed. Expected https://s.shopee.co.th/{shortCode}, got ${getSafeHostname(affiliateUrl)}`,
      422,
      "shopee_short_link_invalid",
      "config"
    );
  }

  const doc = await AffiliateLink.findOneAndUpdate(
    {
      userId: input.userId,
      productId: input.product.productId,
      trackingId,
      subId: subIds.subId,
      subId1: subIds.subId1,
      subId2: subIds.subId2,
      subId3: subIds.subId3,
      subId4: subIds.subId4,
      subId5: subIds.subId5
    },
    {
      userId: input.userId,
      productId: input.product.productId,
      shopId: input.product.shopId,
      itemId: input.product.itemId,
      originalUrl,
      sourceUrl: originalUrl,
      affiliateUrl,
      shortUrl: affiliateUrl,
      trackingId,
      subId: subIds.subId,
      subId1: subIds.subId1,
      subId2: subIds.subId2,
      subId3: subIds.subId3,
      subId4: subIds.subId4,
      subId5: subIds.subId5,
      status: "active",
      lastError: null,
      metadataJson: {
        source: "shopee-affiliate",
        shopName: input.product.shopName ?? "",
        category: input.product.category,
        pageId: input.pageId ?? "",
        trackingId,
        subIds,
        shortUrl: affiliateUrl
      }
    },
    { upsert: true, new: true }
  );

  await logShopeeAutomationEvent({
    userId: input.userId,
    level: "info",
    message: "Shopee affiliate short link generated",
    pageId: input.pageId,
    productId: input.product.productId,
    metadata: {
      trackingId,
      subId: subIds.subId,
      subId1: subIds.subId1,
      subId2: subIds.subId2,
      subId3: subIds.subId3,
      subId4: subIds.subId4,
      subId5: subIds.subId5,
      shortUrl: affiliateUrl
    }
  });

  return {
    trackingId,
    subIds,
    originalUrl,
    affiliateUrl,
    shortUrl: affiliateUrl
  };
}

export function scoreShopeeProduct(input: {
  product: ShopeeProductRecord;
  categoryPriority?: string[];
  recentlyPosted?: boolean;
  blockedCategories?: string[];
}): ProductScore {
  const { product } = input;
  const reason: string[] = [];
  const riskFlags: string[] = [];
  let score = 30;

  const sales = product.salesCount ?? 0;
  if (sales >= 10000) {
    score += 18;
    reason.push("Ã Â¸Â¢Ã Â¸Â­Ã Â¸â€Ã Â¸â€šÃ Â¸Â²Ã Â¸Â¢Ã Â¸ÂªÃ Â¸Â¹Ã Â¸â€¡Ã Â¸Â¡Ã Â¸Â²Ã Â¸Â");
  } else if (sales >= 3000) {
    score += 12;
    reason.push("Ã Â¸Â¢Ã Â¸Â­Ã Â¸â€Ã Â¸â€šÃ Â¸Â²Ã Â¸Â¢Ã Â¸â€Ã Â¸Âµ");
  } else if (sales > 0) {
    score += 6;
    reason.push("Ã Â¸Â¡Ã Â¸ÂµÃ Â¸ÂªÃ Â¸Â±Ã Â¸ÂÃ Â¸ÂÃ Â¸Â²Ã Â¸â€œÃ Â¸Â¢Ã Â¸Â­Ã Â¸â€Ã Â¸â€šÃ Â¸Â²Ã Â¸Â¢");
  }

  const rating = product.rating ?? 0;
  if (rating >= 4.8) {
    score += 14;
    reason.push("Ã Â¹â‚¬Ã Â¸Â£Ã Â¸â€¢Ã Â¸â€¢Ã Â¸Â´Ã Â¹â€°Ã Â¸â€¡Ã Â¸â€Ã Â¸ÂµÃ Â¸Â¡Ã Â¸Â²Ã Â¸Â");
  } else if (rating >= 4.5) {
    score += 10;
    reason.push("Ã Â¹â‚¬Ã Â¸Â£Ã Â¸â€¢Ã Â¸â€¢Ã Â¸Â´Ã Â¹â€°Ã Â¸â€¡Ã Â¸â€Ã Â¸Âµ");
  } else if (rating > 0 && rating < 4.2) {
    score -= 10;
    riskFlags.push("rating_low");
  }

  const discount = product.discountPercent ?? 0;
  if (discount >= 45) {
    score += 14;
    reason.push("Ã Â¸ÂªÃ Â¹Ë†Ã Â¸Â§Ã Â¸â„¢Ã Â¸Â¥Ã Â¸â€Ã Â¹â‚¬Ã Â¸â€Ã Â¹Ë†Ã Â¸â„¢");
  } else if (discount >= 20) {
    score += 8;
    reason.push("Ã Â¸Â¡Ã Â¸ÂµÃ Â¸ÂªÃ Â¹Ë†Ã Â¸Â§Ã Â¸â„¢Ã Â¸Â¥Ã Â¸â€Ã Â¸â„¢Ã Â¹Ë†Ã Â¸Â²Ã Â¸ÂªÃ Â¸â„¢Ã Â¹Æ’Ã Â¸Ë†");
  }

  const commission = product.commissionRate ?? 0;
  if (commission >= 8) {
    score += 10;
    reason.push("Ã Â¸â€žÃ Â¸Â­Ã Â¸Â¡Ã Â¸Â¡Ã Â¸Â´Ã Â¸Å Ã Â¸Å Ã Â¸Â±Ã Â¸â„¢Ã Â¸â€Ã Â¸Âµ");
  } else if (commission >= 5) {
    score += 6;
    reason.push("Ã Â¸â€žÃ Â¸Â­Ã Â¸Â¡Ã Â¸Â¡Ã Â¸Â´Ã Â¸Å Ã Â¸Å Ã Â¸Â±Ã Â¸â„¢Ã Â¹Æ’Ã Â¸Å Ã Â¹â€°Ã Â¹â€žÃ Â¸â€Ã Â¹â€°");
  }

  if (product.sourceTag === "trending" || product.sourceTag === "best_selling") {
    score += 10;
    reason.push(product.sourceTag === "trending" ? "Ã Â¸ÂªÃ Â¸Â´Ã Â¸â„¢Ã Â¸â€žÃ Â¹â€°Ã Â¸Â²Ã Â¸Â­Ã Â¸Â¢Ã Â¸Â¹Ã Â¹Ë†Ã Â¹Æ’Ã Â¸â„¢Ã Â¸ÂÃ Â¸Â£Ã Â¸Â°Ã Â¹ÂÃ Â¸Âª" : "Ã Â¸ÂªÃ Â¸Â´Ã Â¸â„¢Ã Â¸â€žÃ Â¹â€°Ã Â¸Â² best-selling");
  }

  const reviews = product.reviewCount ?? 0;
  if (reviews >= 1000) {
    score += 8;
    reason.push("Ã Â¸Â¡Ã Â¸ÂµÃ Â¸Â£Ã Â¸ÂµÃ Â¸Â§Ã Â¸Â´Ã Â¸Â§Ã Â¸Ë†Ã Â¸Â³Ã Â¸â„¢Ã Â¸Â§Ã Â¸â„¢Ã Â¸Â¡Ã Â¸Â²Ã Â¸Â");
  } else if (reviews >= 100) {
    score += 4;
    reason.push("Ã Â¸Â¡Ã Â¸ÂµÃ Â¸Â£Ã Â¸ÂµÃ Â¸Â§Ã Â¸Â´Ã Â¸Â§Ã Â¸Å Ã Â¹Ë†Ã Â¸Â§Ã Â¸Â¢Ã Â¸â€ºÃ Â¸Â£Ã Â¸Â°Ã Â¸ÂÃ Â¸Â­Ã Â¸Å¡Ã Â¸ÂÃ Â¸Â²Ã Â¸Â£Ã Â¸â€¢Ã Â¸Â±Ã Â¸â€Ã Â¸ÂªÃ Â¸Â´Ã Â¸â„¢Ã Â¹Æ’Ã Â¸Ë†");
  }

  if (input.categoryPriority?.includes(product.category)) {
    score += 7;
    reason.push("Ã Â¸â€¢Ã Â¸Â£Ã Â¸â€¡Ã Â¸Â«Ã Â¸Â¡Ã Â¸Â§Ã Â¸â€Ã Â¸Â«Ã Â¸Â¡Ã Â¸Â¹Ã Â¹Ë†Ã Â¸â€”Ã Â¸ÂµÃ Â¹Ë†Ã Â¸â€¢Ã Â¸Â±Ã Â¹â€°Ã Â¸â€¡Ã Â¸â€žÃ Â¹Ë†Ã Â¸Â²Ã Â¹â€žÃ Â¸Â§Ã Â¹â€°");
  }

  if (input.blockedCategories?.includes(product.category)) {
    score -= 80;
    riskFlags.push("blocked_category");
  }

  if (input.recentlyPosted) {
    score -= 60;
    riskFlags.push("recent_duplicate");
  }

  if (!product.productImageUrl) {
    score -= 20;
    riskFlags.push("missing_image");
  }

  if (!product.productUrl && !product.affiliateUrl) {
    score -= 40;
    riskFlags.push("missing_product_url");
  }

  return {
    productScore: Math.max(0, Math.min(100, Math.round(score))),
    reason: reason.length ? reason : ["Ã Â¸ÂªÃ Â¸Â´Ã Â¸â„¢Ã Â¸â€žÃ Â¹â€°Ã Â¸Â²Ã Â¸Â­Ã Â¸Â¢Ã Â¸Â¹Ã Â¹Ë†Ã Â¹Æ’Ã Â¸â„¢Ã Â¹â‚¬Ã Â¸ÂÃ Â¸â€œÃ Â¸â€˜Ã Â¹Å’Ã Â¸Å¾Ã Â¸Â·Ã Â¹â€°Ã Â¸â„¢Ã Â¸ÂÃ Â¸Â²Ã Â¸â„¢"],
    riskFlags
  };
}

export async function upsertShopeeProducts(products: ShopeeProductRecord[]) {
  const saved = [];
  for (const product of products) {
    saved.push(
      await ShopeeProduct.findOneAndUpdate(
        { productId: product.productId },
        {
          productId: product.productId,
          shopId: product.shopId,
          itemId: product.itemId,
          productName: product.productName,
          productDescription: product.productDescription,
          productPrice: product.productPrice,
          discountPrice: product.discountPrice,
          discountPercent: product.discountPercent,
          productImageUrl: product.productImageUrl,
          productImageUrls: product.productImageUrls ?? (product.productImageUrl ? [product.productImageUrl] : []),
          productUrl: product.productUrl,
          affiliateUrl: product.affiliateUrl,
          category: product.category,
          salesCount: product.salesCount,
          reviewCount: product.reviewCount ?? 0,
          shopName: product.shopName ?? "",
          rating: product.rating,
          commissionRate: product.commissionRate,
          sourceTag: product.sourceTag,
          fetchedAt: product.fetchedAt
        },
        { upsert: true, new: true }
      )
    );
  }
  return saved;
}

export async function wasProductRecentlyPosted(userId: string, pageId: string, productId: string, windowDays = 14) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const count = await ProductPostHistory.countDocuments({
    userId,
    pageId,
    productId,
    postedAt: { $gte: since },
    status: { $in: ["queued", "published"] }
  });
  return count > 0;
}

export async function selectShopeeProductsForPages(input: {
  userId: string;
  pageIds: string[];
  sourceTag?: ShopeeSourceTag;
  keyword?: string;
  category?: string;
  categoryPriority?: string[];
  blockedCategories?: string[];
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  minSales?: number;
  minDiscountPercent?: number;
  excludedProductIds?: string[];
}) {
  const provider = getShopeeProductProvider();
  const excludedProductIds = new Set((input.excludedProductIds ?? []).map((productId) => String(productId)).filter(Boolean));
  const discovered = await provider.fetchProducts({
    sourceTag: input.sourceTag ?? "trending",
    keyword: input.keyword,
    category: input.category,
    limit: Math.max(20, input.pageIds.length * Math.max(5, excludedProductIds.size + 5))
  });
  await upsertShopeeProducts(discovered);

  const selected: Array<{ pageId: string; product: ShopeeProductRecord; score: ProductScore }> = [];
  const filteredProducts = discovered.filter((product) => {
    if (excludedProductIds.has(String(product.productId))) return false;
    const effectivePrice = product.discountPrice || product.productPrice || 0;
    if ((input.minPrice ?? 0) > 0 && effectivePrice < (input.minPrice ?? 0)) return false;
    if ((input.maxPrice ?? 0) > 0 && effectivePrice > (input.maxPrice ?? 0)) return false;
    if ((input.minRating ?? 0) > 0 && (product.rating ?? 0) < (input.minRating ?? 0)) return false;
    if ((input.minSales ?? 0) > 0 && (product.salesCount ?? 0) < (input.minSales ?? 0)) return false;
    if ((input.minDiscountPercent ?? 0) > 0 && (product.discountPercent ?? 0) < (input.minDiscountPercent ?? 0)) return false;
    return true;
  });

  for (const pageId of input.pageIds) {
    const scored = [];
    for (const product of filteredProducts) {
      const recentlyPosted = await wasProductRecentlyPosted(input.userId, pageId, product.productId);
      const score = scoreShopeeProduct({
        product,
        recentlyPosted,
        categoryPriority: input.categoryPriority,
        blockedCategories: input.blockedCategories
      });
      if (!score.riskFlags.includes("blocked_category") && !score.riskFlags.includes("missing_product_url")) {
        scored.push({ product, score });
      }
    }

    const best = scored
      .filter((item) => item.score.productScore >= 35)
      .sort((left, right) => right.score.productScore - left.score.productScore)[0];

    if (!best) {
      continue;
    }

    selected.push({ pageId, product: best.product, score: best.score });
  }

  if (!selected.length) {
    throw new Error("No eligible Shopee products found for the current filters");
  }

  return selected;
}

export function buildShopeeImagePrompt(product: ShopeeProductRecord, style: ShopeeCaptionStyle = "soft_sell") {
  return buildShopeeImagePromptSet(product, style).prompts[0].prompt;
}

export function buildShopeeImagePromptSet(product: ShopeeProductRecord, style: ShopeeCaptionStyle = "soft_sell") {
  return buildShopeeImagePromptSetCore(product, style);
}

export async function generateShopeeCaption(input: {
  userId: string;
  product: ShopeeProductRecord;
  affiliateLink: string;
  style?: ShopeeCaptionStyle;
  disclosureText?: string;
}) {
  const { product } = input;
  const priceLine = product.discountPrice
    ? `\u0e23\u0e32\u0e04\u0e32\u0e42\u0e1b\u0e23: ${product.discountPrice.toLocaleString("th-TH")} \u0e1a\u0e32\u0e17${product.discountPercent ? ` \u0e25\u0e14\u0e1b\u0e23\u0e30\u0e21\u0e32\u0e13 ${product.discountPercent}%` : ""}`
    : product.productPrice
      ? `\u0e23\u0e32\u0e04\u0e32: ${product.productPrice.toLocaleString("th-TH")} \u0e1a\u0e32\u0e17`
      : "\u0e23\u0e32\u0e04\u0e32: \u0e14\u0e39\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e43\u0e19\u0e25\u0e34\u0e07\u0e01\u0e4c";
  const fallback = buildShopeeFallbackCaption(product, input.affiliateLink);
  const productFactLines = collectShopeeProductFacts(product).map((line) => stripShopeeLeadingEmoji(line));

  const customPrompt = [
    "à¹€à¸‚à¸µà¸¢à¸™à¹‚à¸žà¸ªà¸•à¹Œà¸£à¸µà¸§à¸´à¸§à¸ªà¸´à¸™à¸„à¹‰à¸² Shopee Affiliate à¸ªà¸³à¸«à¸£à¸±à¸š Facebook Page à¸•à¸²à¸¡ format à¸™à¸µà¹‰à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™",
    "",
    "FORMAT:",
    `${product.productName}`,
    "",
    "{hook_line à¸—à¸µà¹ˆà¸­à¸´à¸‡à¸ˆà¸²à¸à¸ªà¸´à¸™à¸„à¹‰à¸²à¹‚à¸”à¸¢à¸•à¸£à¸‡ à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰ hook à¸ªà¸³à¹€à¸£à¹‡à¸ˆà¸£à¸¹à¸›}",
    "",
    "âœ¨ {feeling_line à¸ à¸²à¸©à¸²à¸„à¸™à¸ˆà¸£à¸´à¸‡ 1 à¸šà¸£à¸£à¸—à¸±à¸” à¸­à¸´à¸‡à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¸ªà¸´à¸™à¸„à¹‰à¸²}",
    "",
    "ðŸ“Œ à¸ˆà¸¸à¸”à¹€à¸”à¹ˆà¸™à¸—à¸µà¹ˆà¸Šà¸­à¸š",
    "",
    "âœ… {feature_1 à¸ˆà¸²à¸à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ªà¸´à¸™à¸„à¹‰à¸²à¸ˆà¸£à¸´à¸‡}",
    "",
    "âœ… {feature_2 à¸ˆà¸²à¸à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ªà¸´à¸™à¸„à¹‰à¸²à¸ˆà¸£à¸´à¸‡}",
    "",
    "âœ… {feature_3 à¸–à¹‰à¸²à¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ˆà¸£à¸´à¸‡}",
    "",
    "âœ… {feature_4 à¸–à¹‰à¸²à¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ˆà¸£à¸´à¸‡}",
    "",
    `{price_line à¹ƒà¸Šà¹‰à¸„à¸£à¸±à¹‰à¸‡à¹€à¸”à¸µà¸¢à¸§à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™: ${formatShopeePrice(product) || priceLine}}`,
    "",
    "ðŸ›’ à¸à¸”à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡",
    "",
    `ðŸ“ à¸žà¸´à¸à¸±à¸” ${input.affiliateLink}`,
    "",
    "{hashtags 3-5 à¸­à¸±à¸™ à¹€à¸à¸µà¹ˆà¸¢à¸§à¸‚à¹‰à¸­à¸‡à¸à¸±à¸šà¸ªà¸´à¸™à¸„à¹‰à¸²à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™ à¸­à¸¢à¸¹à¹ˆà¸¥à¹ˆà¸²à¸‡à¸ªà¸¸à¸”}",
    "",
    "à¸à¸Žà¸ªà¸³à¸„à¸±à¸:",
    "- CRITICAL: Product name must appear exactly once, on the first line only.",
    "- Do not repeat product name in hook, feeling line, product detail, bullet points, CTA, or hashtags.",
    "- Product details must summarize actual material, size, usage, quantity, function, or practical benefit. Never copy the product name as a detail.",
    "- If any source description is the same as the product name or more than 70% similar, ignore that description.",
    "- à¸«à¹‰à¸²à¸¡à¸™à¸³ category à¸¡à¸²à¹€à¸›à¹‡à¸™ feature à¹€à¸”à¹‡à¸”à¸‚à¸²à¸” à¹€à¸Šà¹ˆà¸™ General, Lifestyle, Beauty, Home",
    "- Feature à¸•à¹‰à¸­à¸‡à¸¡à¸²à¸ˆà¸²à¸ product description, specifications, attributes, product features, variants à¸«à¸£à¸·à¸­ title à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™",
    "- à¸–à¹‰à¸²à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ feature à¹„à¸¡à¹ˆà¸žà¸­ à¹ƒà¸«à¹‰à¹€à¸‚à¸µà¸¢à¸™à¹à¸„à¹ˆ 2-3 feature à¸”à¸µà¸à¸§à¹ˆà¸²à¸ªà¸£à¹‰à¸²à¸‡à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸¡à¸±à¹ˆà¸§",
    "- à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰à¸«à¸±à¸§à¸‚à¹‰à¸­à¸‹à¹‰à¸³ à¹€à¸Šà¹ˆà¸™ 'âœ¨ à¸„à¸§à¸²à¸¡à¸£à¸¹à¹‰à¸ªà¸¶à¸à¸«à¸¥à¸±à¸‡à¹ƒà¸Šà¹‰à¸‡à¸²à¸™' à¹ƒà¸«à¹‰à¹ƒà¸Šà¹‰à¹€à¸‰à¸žà¸²à¸° 'âœ¨ {feeling_line}'",
    "- à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰à¹€à¸ªà¹‰à¸™à¸„à¸±à¹ˆà¸™à¸—à¸¸à¸à¹à¸šà¸š à¹€à¸Šà¹ˆà¸™ â”â”â”â”â”, ---, ===",
    "- à¸«à¹‰à¸²à¸¡à¹à¸ªà¸”à¸‡à¸£à¸²à¸„à¸²à¹€à¸à¸´à¸™ 1 à¸„à¸£à¸±à¹‰à¸‡",
    "- Hook à¸•à¹‰à¸­à¸‡à¸­à¸´à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸² à¹€à¸Šà¹ˆà¸™ à¹„à¸«à¸¡à¸‚à¸±à¸”à¸Ÿà¸±à¸™=à¸‹à¸·à¹‰à¸­à¸„à¸£à¸±à¹‰à¸‡à¹€à¸”à¸µà¸¢à¸§à¹ƒà¸Šà¹‰à¹„à¸”à¹‰à¸™à¸²à¸™à¸«à¸¥à¸²à¸¢à¹€à¸”à¸·à¸­à¸™, à¸à¸²à¸‡à¹€à¸à¸‡à¸à¸µà¸¬à¸²=à¹ƒà¸ªà¹ˆà¸§à¸´à¹ˆà¸‡à¹à¸¥à¹‰à¸§à¸„à¸¥à¹ˆà¸­à¸‡à¸•à¸±à¸§, à¹à¸à¹‰à¸§=à¸™à¹‰à¸³à¹à¸‚à¹‡à¸‡à¸¢à¸±à¸‡à¸­à¸¢à¸¹à¹ˆà¸«à¸¥à¸±à¸‡à¹€à¸¥à¸´à¸à¸‡à¸²à¸™",
    "- à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰ hook à¸ªà¸³à¹€à¸£à¹‡à¸ˆà¸£à¸¹à¸› à¹€à¸Šà¹ˆà¸™ à¸¥à¸­à¸‡à¹à¸¥à¹‰à¸§à¸Šà¸­à¸šà¸à¸§à¹ˆà¸²à¸—à¸µà¹ˆà¸„à¸´à¸”, à¹ƒà¸Šà¹‰à¹à¸¥à¹‰à¸§à¸•à¸´à¸”à¹ƒà¸ˆ, à¸„à¸¸à¹‰à¸¡à¸¡à¸²à¸",
    "- CTA à¸•à¹‰à¸­à¸‡à¸­à¸¢à¸¹à¹ˆà¹€à¸«à¸™à¸·à¸­ link à¸•à¸²à¸¡à¸£à¸¹à¸›à¹à¸šà¸š: ðŸ›’ à¸à¸”à¸”à¸¹à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡ à¹à¸¥à¹‰à¸§à¸•à¸²à¸¡à¸”à¹‰à¸§à¸¢ ðŸ“ à¸žà¸´à¸à¸±à¸” {link}",
    "- Hashtag à¸•à¹‰à¸­à¸‡à¹€à¸à¸µà¹ˆà¸¢à¸§à¸‚à¹‰à¸­à¸‡à¸à¸±à¸šà¸ªà¸´à¸™à¸„à¹‰à¸² à¸«à¹‰à¸²à¸¡ #General #Lifestyle #Beauty #Category #Product",
    "- à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰à¸„à¸°à¹à¸™à¸™à¸£à¹‰à¸²à¸™ à¸¢à¸­à¸”à¸‚à¸²à¸¢ à¸ˆà¸³à¸™à¸§à¸™à¸£à¸µà¸§à¸´à¸§ bestseller à¸‚à¸²à¸¢à¸”à¸µà¸­à¸±à¸™à¸”à¸±à¸š 1",
    "- à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰à¸„à¸³à¸§à¹ˆà¸² à¸«à¸¡à¸²à¸¢à¹€à¸«à¸•à¸¸ à¸«à¸£à¸·à¸­ affiliate",
    "- à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰ internal redirect URL",
    "- à¹„à¸¡à¹ˆà¹€à¸à¸´à¸™ 700 à¸•à¸±à¸§à¸­à¸±à¸à¸©à¸£ à¹à¸¥à¸°à¸­à¹ˆà¸²à¸™à¸‡à¹ˆà¸²à¸¢à¸šà¸™à¸¡à¸·à¸­à¸–à¸·à¸­",
    "",
    "Product data:",
    `à¸Šà¸·à¹ˆà¸­à¸ªà¸´à¸™à¸„à¹‰à¸²: ${product.productName}`,
    `à¸«à¸¡à¸§à¸”à¸«à¸¡à¸¹à¹ˆ (à¹ƒà¸Šà¹‰à¹€à¸‚à¹‰à¸²à¹ƒà¸ˆà¸šà¸£à¸´à¸šà¸—à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™ à¸«à¹‰à¸²à¸¡à¹à¸ªà¸”à¸‡à¹€à¸›à¹‡à¸™ feature): ${product.category || "-"}`,
    `à¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¸ªà¸´à¸™à¸„à¹‰à¸²: ${product.productDescription || "-"}`,
    `à¸ˆà¸¸à¸”à¹€à¸”à¹ˆà¸™à¸—à¸µà¹ˆà¸ªà¸à¸±à¸”à¹„à¸”à¹‰à¸ˆà¸²à¸à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ˆà¸£à¸´à¸‡: ${productFactLines.join(" | ") || "-"}`,
    `Shopee Short Link: ${input.affiliateLink}`,
    "",
    "Return caption only inside JSON variants[].caption."
  ].join("\n");

  try {
    const variants = await generateFacebookContent(product.productName, {
      userId: input.userId,
      customPrompt,
      sourceLabel: "Shopee product facts for UGC review caption",
      sourceText: [
        `Product name: ${product.productName}`,
        `Description: ${product.productDescription}`,
        `Extracted facts: ${productFactLines.join(" | ")}`,
        priceLine,
        `Shopee short link: ${input.affiliateLink}`
      ].join("\n")
    });
    const chosen = variants?.length ? randomItem(variants) : null;
    if (!chosen?.caption) return fallback;
    const withLink = chosen.caption.includes(input.affiliateLink)
      ? chosen.caption
      : `${chosen.caption.trim()}\n${input.affiliateLink}`;
    const sanitized = sanitizeShopeeCaption(withLink, input.affiliateLink, product);
    return sanitized.length > input.affiliateLink.length + 20 ? sanitized : fallback;
  } catch {
    return fallback;
  }
}
async function fetchShopeeReferenceImage(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new ShopeeProviderError(
      `Unable to fetch Shopee reference image: ${response.status}`,
      502,
      "shopee_reference_image_fetch_failed",
      "internal_api"
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
  return {
    bytes,
    mimeType: mimeType.startsWith("image/") ? mimeType : "image/jpeg"
  };
}

function bufferToArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function hashImageBuffer(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function generateShopeeUgcImageDocs(input: {
  userId: string;
  jobId?: string;
  product: ShopeeProductRecord;
  promptSet: ReturnType<typeof buildShopeeImagePromptSet>;
  sourceImageUrls: string[];
}) {
  const uniqueSourceImageUrls = Array.from(new Set(input.sourceImageUrls.filter((url) => Boolean(url?.trim())))).slice(0, 4);
  const referenceImages = await Promise.all(uniqueSourceImageUrls.map(fetchShopeeReferenceImage));
  if (referenceImages.length === 0) {
    throw new ShopeeProviderError(
      "Shopee UGC image generation failed: product reference images are missing",
      422,
      "shopee_ugc_reference_image_unavailable",
      "internal_api"
    );
  }

  const sourceHashes = new Set(referenceImages.map((image) => hashImageBuffer(image.bytes)));
  const generatedHashes = new Set<string>();
  const imageDocs = [];

  for (const [index, promptItem] of input.promptSet.prompts.entries()) {
    const primaryReference = referenceImages[index % referenceImages.length];
    let generatedBuffer: Buffer | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        generatedBuffer = await generateProductReferenceImage({
          imageBytes: bufferToArrayBuffer(primaryReference.bytes),
          mimeType: primaryReference.mimeType,
          prompt: [
            promptItem.prompt,
            `Generate image ${index + 1} of 4 only. This image must have a unique angle, environment, distance, camera framing, hand position, and usage context compared with the other three images.`,
            "Use all attached Shopee images as product identity references. Create a new realistic UGC lifestyle photo; do not copy, crop, resize, or reuse the original Shopee product image composition.",
            "No text, no overlay, no product card, no catalog background, no studio packshot."
          ].join("\n"),
          userId: input.userId,
          referenceImages: referenceImages
            .filter((_, referenceIndex) => referenceIndex !== index % referenceImages.length)
            .map((reference) => ({
              imageBytes: bufferToArrayBuffer(reference.bytes),
              mimeType: reference.mimeType
            }))
        });
        const generatedHash = hashImageBuffer(generatedBuffer);
        if (sourceHashes.has(generatedHash)) {
          throw new Error("OpenAI returned the original Shopee product image instead of a new UGC lifestyle image");
        }
        if (generatedHashes.has(generatedHash)) {
          throw new Error("OpenAI returned duplicate UGC images");
        }
        break;
      } catch (error) {
        lastError = error;
        generatedBuffer = null;
      }
    }

    if (!generatedBuffer) {
      throw new ShopeeProviderError(
        `Shopee UGC image generation failed: ${lastError instanceof Error ? lastError.message : "OpenAI did not return a usable UGC image"}`,
        500,
        "shopee_ugc_image_generation_failed",
        "internal_api"
      );
    }
    const generatedHash = hashImageBuffer(generatedBuffer);

    generatedHashes.add(generatedHash);

    const uploadedImage = await uploadAutoPostImage({
      jobId: input.jobId ?? `shopee-${Date.now()}`,
      productId: input.product.productId,
      index: index + 1,
      buffer: generatedBuffer,
      mimeType: "image/png",
      kind: "image"
    });

    const imagePayload = {
      userId: input.userId,
      productId: input.product.productId,
      prompt: promptItem.prompt,
      status: "generated",
      generatedImageUrl: uploadedImage.url,
      pathname: uploadedImage.pathname,
      fallbackImageUrl: input.product.productImageUrl || input.sourceImageUrls[0],
      provider: "vercel_blob_openai_shopee_ugc_photo",
      contentType: uploadedImage.contentType,
      sizeBytes: uploadedImage.sizeBytes,
      promptHistory: [
        promptItem.title,
        `concept=${promptItem.concept}`,
        `layout=${index + 1}`,
        `reference_count=${referenceImages.length}`,
        "source=openai-image-edit-multi-reference",
        "source_fallback_disabled=true",
        "new_ugc_lifestyle_image=true",
        "no_text_overlay=true",
        input.promptSet.negativePrompt
      ]
    };
    assertNoLargeMongoFields(imagePayload, "AiGeneratedImage");
    const imageDoc = await AiGeneratedImage.create(imagePayload);
    imageDocs.push(imageDoc);
  }

  return imageDocs;
}

export async function buildShopeePostPackage(input: {
  userId: string;
  pageId: string;
  product: ShopeeProductRecord;
  scheduledAt: Date;
  captionStyle?: ShopeeCaptionStyle;
  trackingId?: string;
  subIds?: ShopeeSubIdFields;
  jobId?: string;
}) {
  const linkResult = await createOrReuseAffiliateShortLink({
    userId: input.userId,
    product: input.product,
    trackingId: input.trackingId,
    subIds: input.subIds,
    pageId: input.pageId
  });
  const affiliateLink = linkResult.affiliateUrl;
  const shortAffiliateLink = linkResult.shortUrl;
  if (!isShopeeShortLink(shortAffiliateLink)) {
    throw new ShopeeProviderError(
      "Shopee short link validation failed before post generation",
      422,
      "shopee_short_link_invalid",
      "config"
    );
  }
  const imagePromptSet = buildShopeeImagePromptSet(input.product, input.captionStyle ?? "soft_sell");
  const imagePrompts = imagePromptSet.prompts.map((item) => item.prompt);
  const imagePrompt = imagePrompts[0] ?? buildShopeeImagePrompt(input.product, input.captionStyle ?? "soft_sell");
  const caption = await generateShopeeCaption({
    userId: input.userId,
    product: input.product,
    affiliateLink: shortAffiliateLink,
    style: input.captionStyle
  });

  const sourceImageUrls = (input.product.productImageUrls?.length ? input.product.productImageUrls : [input.product.productImageUrl])
    .filter((url): url is string => Boolean(url?.trim()));
  if (sourceImageUrls.length === 0) {
    throw new ShopeeProviderError(
      "Shopee UGC image generation failed: product image is missing",
      422,
      "shopee_ugc_reference_image_unavailable",
      "internal_api"
    );
  }

  const imageDocs = await generateShopeeUgcImageDocs({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    promptSet: imagePromptSet,
    sourceImageUrls
  });

  const postDoc = await AiGeneratedPost.create({
    userId: input.userId,
    productId: input.product.productId,
    caption,
    imagePrompt,
    generatedImageUrl: imageDocs[0] ? `ai-image:${String(imageDocs[0]._id)}` : input.product.productImageUrl,
    affiliateLink: shortAffiliateLink,
    scheduledAt: input.scheduledAt,
    pageId: input.pageId,
    status: "image_ready",
    generationMetaJson: {
      imageId: imageDocs[0] ? String(imageDocs[0]._id) : null,
      imageIds: imageDocs.map((imageDoc) => String(imageDoc._id)),
      generatedImageUrls: imageDocs.map((imageDoc) => `ai-image:${String(imageDoc._id)}`),
      imagePromptSet,
      source: "shopee-affiliate",
      affiliateUrl: linkResult.affiliateUrl,
      shortAffiliateLink,
      trackingId: linkResult.trackingId,
      subIds: linkResult.subIds,
      promptCount: imagePrompts.length
    }
  });
  const generatedImageUrls = imageDocs.map((imageDoc) => `ai-image:${String(imageDoc._id)}`);

  if (generatedImageUrls.length < 4) {
    throw new ShopeeProviderError("AI image generation failed: expected 4 post images", 500, "shopee_image_generation_incomplete", "internal_api");
  }

  return {
    product: input.product,
    caption,
    imagePrompt,
    imagePrompts,
    generatedImageUrl: generatedImageUrls[0],
    generatedImageUrls,
    affiliateLink: shortAffiliateLink,
    shortAffiliateLink,
    imageStatus: "generated",
    scheduledAt: input.scheduledAt,
    pageId: input.pageId,
    status: "image_ready",
    aiGeneratedPostId: String(postDoc._id)
  } satisfies ShopeePostPackage & { aiGeneratedPostId: string };
}

export async function recordShopeeQueueItem(input: {
  userId: string;
  pageId: string;
  product: ShopeeProductRecord;
  postId: string;
  jobId?: string;
  scheduledAt: Date;
  affiliateLink: string;
  aiGeneratedPostId?: string;
  status?: "draft" | "generated" | "image_ready" | "queued" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
}) {
  await FacebookPostQueue.create({
    userId: input.userId,
    pageId: input.pageId,
    postId: input.postId,
    productId: input.product.productId,
    affiliateLink: input.affiliateLink,
    scheduledAt: input.scheduledAt,
    status: input.status ?? "queued",
    aiGeneratedPostId: input.aiGeneratedPostId
  });

  await ProductPostHistory.create({
    userId: input.userId,
    pageId: input.pageId,
    productId: input.product.productId,
    postId: input.postId,
    affiliateLink: input.affiliateLink,
    postedAt: input.scheduledAt,
    status: "queued"
  });

  await AffiliatePerformance.findOneAndUpdate(
    { userId: input.userId, productId: input.product.productId, pageId: input.pageId },
    {
      userId: input.userId,
      productId: input.product.productId,
      pageId: input.pageId,
      affiliateLink: input.affiliateLink,
      $inc: { queuedPosts: 1 }
    },
    { upsert: true, new: true }
  );
}

export async function logShopeeAutomationEvent(input: {
  userId: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  productId?: string;
  pageId?: string;
  metadata?: Record<string, unknown>;
}) {
  await AutomationLog.create({
    userId: input.userId,
    source: "shopee-affiliate",
    level: input.level,
    message: input.message,
    productId: input.productId,
    pageId: input.pageId,
    metadata: input.metadata ?? {}
  });

  await logAction({
    userId: input.userId,
    type: "queue",
    level: input.level,
    message: input.message,
    metadata: {
      shopeeAffiliate: true,
      productId: input.productId,
      pageId: input.pageId,
      ...(input.metadata ?? {})
    }
  });
}
