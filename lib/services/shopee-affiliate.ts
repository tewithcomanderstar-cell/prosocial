import crypto from "crypto";
import {
  buildShopeeImagePromptSet as buildShopeeImagePromptSetCore,
  isShopeeProductNameDuplicateText,
  removeDuplicateShopeeProductNameLines,
  stripShopeeProductNameFromText
} from "@/lib/services/shopee-affiliate-core";
import {
  analyzeShopeeProductImageUnderstanding,
  generateFacebookContent,
  generateProductReferenceImage,
  type ShopeeVisionUnderstandingResult
} from "@/lib/services/ai";
import { assertNoLargeMongoFields, uploadAutoPostImage } from "@/lib/services/blob-storage";
import { logAction, serializeError } from "@/lib/services/logging";
import { logExternalResponseFailure, traceExternalRequest } from "@/lib/services/request-debug";
import { assertValidTextEncoding, normalizeTextEncoding, validateTextEncoding } from "@/lib/services/text-encoding";
import {
  DEFAULT_SHOPEE_CATEGORY,
  getShopeeCategoryLabel,
  getShopeeCategorySearchTerms,
  isShopeeCategoryMatch,
  normalizeShopeeCategories,
  normalizeShopeeCategory
} from "@/lib/shopee-categories";
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
const STORYBOARD_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.STORYBOARD_TIMEOUT_MS ?? "90000")
);
const STORYBOARD_MAX_ATTEMPTS = 2;
const OPENAI_IMAGE_REQUEST_HARD_TIMEOUT_MS = 180_000;
const OPENAI_IMAGE_REQUEST_TIMEOUT_MS = Math.min(
  OPENAI_IMAGE_REQUEST_HARD_TIMEOUT_MS,
  Math.max(30_000, Number(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? String(OPENAI_IMAGE_REQUEST_HARD_TIMEOUT_MS)))
);
const OPENAI_IMAGE_MAX_ATTEMPTS = 2;
const VISION_RESCUE_TIMEOUT_MS = 30_000;
const AUTO_POST_SLOW_STAGE_WARNING_MS = 30_000;
const SHOPEE_ACTION_LOG_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.SHOPEE_ACTION_LOG_TIMEOUT_MS ?? "2500")
);
const SHOPEE_AUTOMATION_LOG_MIRROR_ENABLED = process.env.SHOPEE_AUTOMATION_LOG_MIRROR_ENABLED === "true";
const DISABLED_STORYBOARD_PRESENTATION_VALIDATION_RULES = [
  "storyboard_caption_max_4_benefit_bullets",
  "storyboard_caption_min_benefit_bullets",
  "storyboard_caption_exact_benefit_bullets",
  "storyboard_caption_required_benefit_count",
  "storyboard_caption_max_lines",
  "storyboard_caption_min_lines",
  "storyboard_caption_max_sections",
  "storyboard_caption_exact_structure",
  "storyboard_caption_required_emoji_count",
  "storyboard_caption_max_emoji_count",
  "storyboard_caption_max_hashtags",
  "storyboard_caption_min_hashtags",
  "storyboard_caption_required_closing",
  "storyboard_caption_required_purchase_reason",
  "storyboard_caption_required_problem_line",
  "storyboard_caption_required_solution_line",
  "benefit_bullets",
  "bullet_count",
  "max_bullets",
  "min_bullets",
  "caption_structure",
  "caption_sections",
  "caption_format",
  "presentation_rules"
] as const;

let storyboardValidationDisabledRulesLogged = false;

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
  searchVolume?: number;
  recentSales?: number;
  salesVelocity?: number;
  stock?: number;
  productCreatedAt?: Date;
  sourceApiSignal?: boolean;
  sourceTag: ShopeeSourceTag;
  fetchedAt: Date;
};

export type ProductDiscoveryQuery = {
  sourceTag?: ShopeeSourceTag;
  keyword?: string;
  category?: string;
  categories?: string[];
  limit?: number;
};

export type ProductScore = {
  productScore: number;
  reason: string[];
  riskFlags: string[];
  sourceSpecificScore?: number;
  scoreBreakdown?: Record<string, unknown>;
  finalRank?: number;
  source?: ShopeeSourceTag;
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

export function buildShopeeAffiliatePayload(input: {
  productUrl: string;
  trackingId?: string | null;
}) {
  const payload: Record<string, string> = {
    url: input.productUrl
  };
  const trackingId = input.trackingId?.trim();
  if (trackingId) payload.tracking_id = trackingId;
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

function assertManualKeywordProvided(query: ProductDiscoveryQuery) {
  if (query.sourceTag === "manual" && !query.keyword?.trim()) {
    throw new ShopeeProviderError(
      "Manual keyword search requires a keyword",
      400,
      "manual_keyword_required",
      "internal_api"
    );
  }
}

export class MockShopeeProvider implements ShopeeProductProvider {
  name = "mock_shopee_provider";

  async fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]> {
    assertManualKeywordProvided(query);
    const now = new Date();
    const sourceTag = query.sourceTag ?? "trending";
    const keyword = query.keyword?.trim() || "ของใช้ยอดนิยม";
    const category = getShopeeCategoryLabel(query.category);
    const limit = Math.max(1, Math.min(query.limit ?? 20, 50));

    const samples: ShopeeProductRecord[] = [
      {
        productId: "mock-thermal-cup",
        shopId: "10001",
        itemId: "90001",
        productName: "แก้วเก็บอุณหภูมิพกพา 600ml",
        productDescription: "แก้วสแตนเลสเก็บเย็นและร้อน ฝาปิดแน่น พกไปทำงาน เดินทาง หรือคาเฟ่ได้สะดวก",
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
        productName: "เครื่องดูดฝุ่นไร้สายมินิ",
        productDescription: "ขนาดเล็ก ใช้งานง่าย เหมาะกับโต๊ะทำงาน รถยนต์ และมุมเล็ก ๆ ในบ้าน",
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
        productName: "กระจกแต่งหน้าพร้อมไฟ LED",
        productDescription: "ไฟนุ่ม ปรับมุมได้ เหมาะกับโต๊ะเครื่องแป้งและการแต่งหน้าในห้อง",
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
        productName: "กล่องจัดระเบียบลิ้นชักแบบใส",
        productDescription: "ช่วยแยกของเล็ก ๆ ให้หยิบง่าย โต๊ะดูโล่งขึ้น เหมาะกับบ้านและออฟฟิศ",
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
      return !query.keyword || haystack.includes(keywordLower) || keywordLower.includes("ยอดนิยม");
    });

    return (filtered.length ? filtered : samples).slice(0, limit);
  }
}

export class ShopeeOfficialApiProvider implements ShopeeProductProvider {
  name = "shopee_official_api_provider";

  async fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]> {
    assertManualKeywordProvided(query);
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
    const categoryTerms = getShopeeCategorySearchTerms(query.category);
    if (categoryTerms.length) url.searchParams.set("category", categoryTerms[0]);
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

    const requestStartedAt = Date.now();
    const response = await traceExternalRequest(
      {
        step: "SHOPEE_PRODUCT_SEARCH",
        url: url.toString(),
        fn: "ShopeeOfficialApiProvider.fetchProducts",
        source: "shopee_product_search",
        metadata: {
          authMode,
          sourceTag: query.sourceTag ?? "trending",
          endpointHost: url.host,
          endpointPath: url.pathname
        }
      },
      () => fetch(url, {
        headers,
        cache: "no-store"
      })
    );

    if (!response.ok) {
      const bodySummary = await summarizeResponse(response);
      await logExternalResponseFailure({
        step: "SHOPEE_PRODUCT_SEARCH",
        url: url.toString(),
        fn: "ShopeeOfficialApiProvider.fetchProducts",
        source: "shopee_product_search",
        responseTime: Date.now() - requestStartedAt,
        status: response.status,
        errorMessage: bodySummary,
        metadata: {
          authMode,
          bodySummary,
          endpointHost: url.host,
          endpointPath: url.pathname
        }
      });
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
    return (payload.products ?? []).map(mapExternalProduct(query.sourceTag ?? "trending", { sourceApiSignal: Boolean(query.sourceTag) }));
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

type ShopeeAffiliateGraphqlQueryBuild = {
  graphqlQuery: string;
  listType?: number;
  listTypeApplied: boolean;
  listTypeSkippedReason?: string;
  matchId?: string;
};

function getShopeeAffiliateMatchId() {
  return process.env.SHOPEE_AFFILIATE_MATCH_ID?.trim() || "";
}

function shouldApplyShopeeAffiliateListType(listType: number, matchId: string) {
  if (listType === 0) return true;
  if (matchId) return true;
  return process.env.SHOPEE_AFFILIATE_ALLOW_LISTTYPE_WITHOUT_MATCH_ID === "true";
}

function getShopeeAffiliateGraphqlFields() {
  return `      productName
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
      shopName`;
}

function buildShopeeAffiliateGraphqlQuery(query: ProductDiscoveryQuery): ShopeeAffiliateGraphqlQueryBuild {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
  const listType = getShopeeAffiliateListType(query.sourceTag);
  const matchId = getShopeeAffiliateMatchId();
  const listTypeApplied = shouldApplyShopeeAffiliateListType(listType, matchId);
  const args = [`limit: ${limit}`, "page: 1"];
  if (listTypeApplied) {
    args.push(`listType: ${listType}`);
  } else {
    console.warn("[shopee/provider] affiliate graphql listType skipped", {
      sourceTag: query.sourceTag ?? "trending",
      listType,
      reason: "listType_requires_matchId_but_matchId_missing"
    });
  }
  if (matchId) args.push(`matchId: "${escapeGraphqlString(matchId)}"`);
  const keyword = query.keyword?.trim() || getShopeeCategorySearchTerms(query.category)[0] || "";
  if (keyword) args.push(`keyword: "${escapeGraphqlString(keyword)}"`);

  return {
    graphqlQuery: `query {
  productOfferV2(${args.join(", ")}) {
    nodes {
${getShopeeAffiliateGraphqlFields()}
    }
  }
}`,
    listType,
    listTypeApplied,
    listTypeSkippedReason: listTypeApplied ? undefined : "listType_requires_matchId_but_matchId_missing",
    matchId: matchId || undefined
  };
}

function buildShopeeAffiliateGraphqlFallbackQuery(query: ProductDiscoveryQuery): ShopeeAffiliateGraphqlQueryBuild {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
  return {
    graphqlQuery: `query {
  productOfferV2(limit: ${limit}, page: 1) {
    nodes {
${getShopeeAffiliateGraphqlFields()}
    }
  }
}`,
    listTypeApplied: false,
    listTypeSkippedReason: "minimal_fallback_query"
  };
}

function isShopeeGraphqlSystemError(payload: Record<string, any>) {
  return Array.isArray(payload.errors) && payload.errors.some((error) => {
    const code = error?.extensions?.code ?? error?.code;
    const message = String(error?.message ?? error?.extensions?.message ?? "").toLowerCase();
    return String(code) === "10000" || message.includes("system error");
  });
}

function optionalShopeeNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function optionalShopeeDate(value: unknown) {
  if (!value) return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
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
    searchVolume: optionalShopeeNumber(product.searchVolume),
    recentSales: optionalShopeeNumber(product.recentSales),
    salesVelocity: optionalShopeeNumber(product.salesVelocity),
    stock: optionalShopeeNumber(product.stock),
    productCreatedAt: optionalShopeeDate(product.productCreatedAt),
    sourceApiSignal: Boolean(product.sourceApiSignal),
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
  const categoryTerms = getShopeeCategorySearchTerms(query.category);
  if (categoryTerms.length) {
    mongoQuery.category = {
      $regex: categoryTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      $options: "i"
    };
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
    hasCategory: normalizeShopeeCategory(query.category) !== DEFAULT_SHOPEE_CATEGORY
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
    const products = await fetchShopeeAffiliateGraphqlProductsWithQuery({
      ...input,
      graphqlQuery: primaryQuery.graphqlQuery,
      listTypeApplied: primaryQuery.listTypeApplied,
      listTypeSkippedReason: primaryQuery.listTypeSkippedReason,
      queryMode: "primary"
    });
    if (!products.length && primaryQuery.listTypeApplied) {
      console.warn("[shopee/provider] affiliate graphql returned empty listType result; retrying without listType", {
        sourceTag: input.query.sourceTag ?? "trending",
        listType: primaryQuery.listType,
        hasKeyword: Boolean(input.query.keyword),
        hasCategory: normalizeShopeeCategory(input.query.category) !== DEFAULT_SHOPEE_CATEGORY
      });
      const fallbackQuery = buildShopeeAffiliateGraphqlFallbackQuery(input.query);
      return await fetchShopeeAffiliateGraphqlProductsWithQuery({
        ...input,
        graphqlQuery: fallbackQuery.graphqlQuery,
        listTypeApplied: fallbackQuery.listTypeApplied,
        listTypeSkippedReason: "empty_listType_result",
        queryMode: "minimal"
      });
    }
    return products;
  } catch (error) {
    if (!(error instanceof ShopeeProviderError) || error.code !== "shopee_graphql_system_error") {
      throw error;
    }

    console.warn("[shopee/provider] retrying affiliate graphql with minimal query after system error", {
      sourceTag: input.query.sourceTag ?? "trending",
      hasKeyword: Boolean(input.query.keyword),
      hasCategory: normalizeShopeeCategory(input.query.category) !== DEFAULT_SHOPEE_CATEGORY
    });

    try {
      return await fetchShopeeAffiliateGraphqlProductsWithQuery({
        ...input,
        graphqlQuery: buildShopeeAffiliateGraphqlFallbackQuery(input.query).graphqlQuery,
        listTypeApplied: false,
        listTypeSkippedReason: "minimal_fallback_query",
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
  listTypeApplied: boolean;
  listTypeSkippedReason?: string;
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
    hasCategory: normalizeShopeeCategory(input.query.category) !== DEFAULT_SHOPEE_CATEGORY,
    hasAppId: Boolean(input.appId),
    hasSecret: Boolean(input.secret),
    authMode: "affiliate_graphql",
    queryMode: input.queryMode,
    listTypeApplied: input.listTypeApplied,
    listTypeSkippedReason: input.listTypeSkippedReason,
    signatureGenerated: Boolean(signature),
    authorizationScheme: "SHA256"
  });

  const requestStartedAt = Date.now();
  const response = await traceExternalRequest(
    {
      step: "SHOPEE_AFFILIATE_GRAPHQL_PRODUCT_OFFER",
      url: url.toString(),
      fn: "fetchShopeeAffiliateGraphqlProducts",
      source: "shopee_affiliate_link",
      metadata: {
        authMode: "affiliate_graphql",
        queryMode: input.queryMode,
        sourceTag: input.query.sourceTag ?? "trending",
        listTypeApplied: input.listTypeApplied,
        listTypeSkippedReason: input.listTypeSkippedReason,
        endpointHost: url.host,
        endpointPath: url.pathname
      }
    },
    () => fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: authorization
      },
      body,
      cache: "no-store"
    })
  );

  if (!response.ok) {
    const bodySummary = await summarizeResponse(response);
    await logExternalResponseFailure({
      step: "SHOPEE_AFFILIATE_GRAPHQL_PRODUCT_OFFER",
      url: url.toString(),
      fn: "fetchShopeeAffiliateGraphqlProducts",
      source: "shopee_affiliate_link",
      responseTime: Date.now() - requestStartedAt,
      status: response.status,
      errorMessage: bodySummary,
      metadata: {
        authMode: "affiliate_graphql",
        queryMode: input.queryMode,
        listTypeApplied: input.listTypeApplied,
        listTypeSkippedReason: input.listTypeSkippedReason,
        bodySummary,
        endpointHost: url.host,
        endpointPath: url.pathname
      }
    });
    console.warn("[shopee/provider] affiliate graphql product fetch failed", {
      endpointHost: url.host,
      endpointPath: url.pathname,
      status: response.status,
      bodySummary,
      authMode: "affiliate_graphql",
      queryMode: input.queryMode,
      listTypeApplied: input.listTypeApplied,
      listTypeSkippedReason: input.listTypeSkippedReason,
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
    await logExternalResponseFailure({
      step: "SHOPEE_AFFILIATE_GRAPHQL_PRODUCT_OFFER",
      url: url.toString(),
      fn: "fetchShopeeAffiliateGraphqlProducts",
      source: "shopee_affiliate_link",
      responseTime: Date.now() - requestStartedAt,
      status: response.status,
      errorMessage: summary,
      metadata: {
        authMode: "affiliate_graphql",
        queryMode: input.queryMode,
        listTypeApplied: input.listTypeApplied,
        listTypeSkippedReason: input.listTypeSkippedReason,
        endpointHost: url.host,
        endpointPath: url.pathname,
        graphqlErrors: summary
      }
    });
    console.warn("[shopee/provider] affiliate graphql returned errors", {
      endpointHost: url.host,
      endpointPath: url.pathname,
      queryMode: input.queryMode,
      listTypeApplied: input.listTypeApplied,
      listTypeSkippedReason: input.listTypeSkippedReason,
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
    listTypeApplied: input.listTypeApplied,
    listTypeSkippedReason: input.listTypeSkippedReason,
    productsCount: Array.isArray(nodes) ? nodes.length : 0
  });

  return (Array.isArray(nodes) ? nodes : []).map(
    mapExternalProduct(input.query.sourceTag ?? "trending", { sourceApiSignal: input.listTypeApplied })
  );
}

function mapExternalProduct(sourceTag: ShopeeSourceTag, options: { sourceApiSignal?: boolean } = {}) {
  return (item: Record<string, unknown>): ShopeeProductRecord => {
    const productId = String(item.product_id ?? item.productId ?? item.item_id ?? item.itemId ?? crypto.randomUUID());
    const shopId = String(item.shop_id ?? item.shopId ?? "");
    const itemId = String(item.item_id ?? item.itemId ?? productId);
    const productCreatedAt = item.product_created_at ?? item.productCreatedAt ?? item.created_at ?? item.createdAt;
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
      searchVolume: optionalShopeeNumber(item.search_volume ?? item.searchVolume ?? item.search_count ?? item.searchCount),
      recentSales: optionalShopeeNumber(item.recent_sales ?? item.recentSales),
      salesVelocity: optionalShopeeNumber(item.sales_velocity ?? item.salesVelocity),
      stock: optionalShopeeNumber(item.stock ?? item.stockCount ?? item.availability),
      productCreatedAt: optionalShopeeDate(productCreatedAt),
      sourceApiSignal: Boolean(options.sourceApiSignal),
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

export function buildAffiliateLink(product: ShopeeProductRecord, trackingId?: string) {
  if (product.affiliateUrl) {
    return product.affiliateUrl;
  }

  const base = process.env.SHOPEE_AFFILIATE_BASE_URL?.trim();
  const resolvedTrackingId = trackingId?.trim() || process.env.SHOPEE_TRACKING_ID?.trim() || process.env.SHOPEE_AFFILIATE_ID?.trim();
  const sourceUrl = product.productUrl || `https://shopee.co.th/product/${product.shopId}/${product.itemId}`;
  const payload = buildShopeeAffiliatePayload({
    productUrl: sourceUrl,
    trackingId: resolvedTrackingId
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
    const requestStartedAt = Date.now();
    const response = await traceExternalRequest(
      {
        step: "SHOPEE_PRODUCT_IMAGE_REFERENCE_FETCH",
        url,
        fn: "fetchImageForAiEdit",
        source: "image_generation_reference_fetch"
      },
      () => fetch(url, { cache: "no-store" })
    );
    if (!response.ok) {
      await logExternalResponseFailure({
        step: "SHOPEE_PRODUCT_IMAGE_REFERENCE_FETCH",
        url,
        fn: "fetchImageForAiEdit",
        source: "image_generation_reference_fetch",
        responseTime: Date.now() - requestStartedAt,
        status: response.status,
        errorMessage: `Shopee reference image returned ${response.status}`
      });
      return null;
    }
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

function getShopeeShortLinkValidationReason(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return "missing_short_link";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return "short_link_must_use_https";
    if (url.hostname !== "s.shopee.co.th") return "short_link_domain_invalid";
    if (url.pathname.length <= 1) return "short_code_missing";
    return "unknown_invalid_short_link";
  } catch {
    return "short_link_url_invalid";
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
  /สินค้าคุณภาพดี/gi,
  /โปรโมชั่นสุดคุ้ม/gi,
  /รีบสั่งซื้อ/gi,
  /รีบซื้อด่วน/gi,
  /โปรโมชั่นห้ามพลาด/gi,
  /รีบกดก่อนหมด/gi,
  /ของมันต้องมี/gi,
  /ซื้อเลยตอนนี้/gi,
  /พลาดไม่ได้/gi,
  /ลดกระหน่ำ/gi,
  /คุ้มสุด/gi,
  /ขายดีอันดับ\s*1/gi,
  /สินค้าขายดีที่สุด/gi,
  /ห้ามพลาด/gi
];

const SHOPEE_FORBIDDEN_OPENERS = [
  /^เข้าใจแล้วว่าทำไม/i,
  /^ตอนแรกคิดว่า/i,
  /^ตอนแรกไม่ได้/i,
  /^อันนี้คือ/i,
  /^เห็นคนรีวิวเยอะ/i,
  /^ใช้แล้วเข้าใจเลย/i,
  /^ของจริงสวยกว่า/i,
  /^โคตรเหมาะกับ/i,
  /^ใครกำลังหา.*ลองดูตัวนี้ก่อน/i,
  /^Stop scrolling/i,
  /^Here are Shopee finds/i
];

const SHOPEE_CONTEXTLESS_GENERIC_PHRASES = [
  "ใช้งานได้ดี",
  "สะดวก",
  "คุ้มค่า",
  "เลือกได้ง่าย",
  "เหมาะกับการใช้งาน",
  "เหมาะสำหรับ",
  "ใช้ได้หลายแบบ",
  "ตามภาพ",
  "ตามข้อมูล"
];

const SHOPEE_SOFT_CTAS = [
  "🛒 กดดูรายละเอียดเพิ่มเติม",
  "📌 ดูราคาและโปรล่าสุด",
  "✨ เข้าไปดูรีวิวเพิ่มเติมได้เลย",
  "🎯 เผื่อกำลังมองหาสินค้าแนวนี้อยู่",
  "💥 ลองกดเข้าไปดูรายละเอียดก่อนตัดสินใจ",
  "🛒 กดดูรายละเอียดเพิ่มเติมได้ที่",
  "📌 ดูราคาและโปรล่าสุดที่ลิงก์ด้านล่าง",
  "✨ ลองเข้าไปดูรายละเอียดก่อนตัดสินใจได้เลย",
  "🎯 เผื่อกำลังหาสินค้าแนวนี้อยู่ ลองดูได้ครับ",
  TH.interestedCta,
  TH.detailsCta,
  TH.linkCta,
  TH.moreCta,
  "ใครสนใจลองดูรายละเอียดได้ครับ"
];

const SHOPEE_HASHTAG_FALLBACKS = ["#Shopee", "#ของใช้ดีบอกต่อ"];

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
  "ทั่วไป",
  "ไลฟ์สไตล์",
  "ความงาม",
  "หมวดหมู่",
  "สินค้า",
  "บ้าน"
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
  /คะแนนร้าน/iu,
  /ร้านได้คะแนน/iu,
  /คะแนนรีวิว/iu,
  /จำนวนรีวิว/iu,
  /ยอดขาย/iu,
  /ขายแล้ว/iu,
  /ขายไปแล้ว/iu,
  /ขายดีอันดับ/iu,
  /อันดับ\s*1/iu,
  /bestseller/iu,
  /best\s*seller/iu,
  /review count/iu,
  /sales count/iu,
  /rating/iu
];

const SHOPEE_FORBIDDEN_GENERIC_PHRASES = [
  "เลือกจากรายละเอียดสินค้าแล้วดูใช้งานได้จริง",
  "ดูจากรายละเอียดสินค้า",
  "จากข้อมูลที่ระบุ",
  "เลือกดูจากชื่อสินค้า",
  "เลือกดูจากรายละเอียดสินค้า",
  "ตามสเปกที่แจ้งไว้",
  "ตามข้อมูลผู้ขาย",
  "ตามข้อมูล",
  "ตามรายละเอียดที่ระบุ",
  "จากคำอธิบายสินค้า",
  "จากรูปแบบสินค้า",
  "จากรูปภาพสินค้า",
  "รูปแบบที่เห็นในภาพ",
  "จากภาพสินค้า",
  "ตอบโจทย์ผู้ที่",
  "ช่วยให้ตัดสินใจเลือก",
  "อ่านรายละเอียดก่อนเลือกซื้อ",
  "อ่านรายละเอียดก่อนเลือก",
  "เลือกจากรุ่น สี ขนาด หรือแพ็กที่ระบุไว้",
  "เลือกจากชื่อสินค้า รูปสินค้า รายละเอียด ขนาด สี รุ่น จำนวน หรือแพ็กที่ระบุไว้",
  "ดูรายละเอียดจากชื่อและรูปสินค้าได้",
  "ดูรายละเอียดสารอาหารก่อนเลือกได้",
  "ดูส่วนผสมและวิธีใช้ได้จากหน้าสินค้า",
  "ดูจากส่วนผสมและวิธีใช้ได้ชัดเจน",
  "ดูจากส่วนผสมและคุณสมบัติ",
  "เหมาะสำหรับผู้ใช้งานทั่วไป",
  "เหมาะกับหมวด General",
  "เหมาะกับหมวด Lifestyle",
  "เหมาะกับหมวด Beauty",
  "เหมาะกับหมวด",
  "เหมาะกับการใช้งานทั่วไป",
  "ใช้งานได้ตามวัตถุประสงค์",
  "รูปแบบสินค้าเข้าใจง่าย",
  "ขนาดหรือจำนวนระบุชัดเจน",
  "ขนาดหรือจำนวนระบุไว้ชัด",
  "ความจุ",
  "น้ำหนักเบา",
  "วัสดุคุณภาพดี",
  "รูปทรงสวยงาม",
  "ผลิตจากสแตนเลส",
  "สแตนเลส 304",
  "ใช้ในสถานการณ์ที่สินค้าออกแบบมา",
  "เหมาะกับผู้ที่กำลังมองหาสินค้าประเภทนี้",
  "เหมาะสำหรับการใช้งานในชีวิตประจำวัน",
  "คุ้มค่ากับราคา",
  "จากข้อมูลสินค้า",
  "จากรายละเอียดสินค้า",
  "ใช้งานได้จริง",
  "ใช้ในชีวิตประจำวัน",
  "ใช้ได้ทุกวัน",
  "เหมาะกับโต๊ะทำงาน",
  "จัดบ้าน",
  "ใส่สบายทั้งวัน",
  "คุณสมบัติสินค้า",
  "สินค้าประเภท",
  "วิเคราะห์จากรูป",
  "วิเคราะห์จากชื่อสินค้า",
  "ดูจากข้อมูล",
  "ชื่อสินค้า",
  "รูปสินค้า",
  "ภาพสินค้า",
  "จากภาพ",
  "จากชื่อ",
  "จากข้อมูล",
  "จากรายละเอียดสินค้า",
  "จากคำอธิบายสินค้า",
  "อ้างอิงจาก",
  "กระบวนการวิเคราะห์",
  "ตรวจสเปก",
  "ตรวจรายละเอียด",
  "จุดเด่นที่ชอบ:",
  "ความรู้สึกหลังใช้งาน:",
  "ความรู้สึกหลังใช้:",
  "เหตุผลที่ซื้อ:",
  "ลองเช็กโปรหน้าสินค้าได้เลย",
  "รับประกันร้านค้า",
  "จัดส่งเร็ว",
  "ตรวจจุดเด่นให้ตรงกับการใช้งาน",
  "เลือกจากขนาด วัสดุ หรือฟังก์ชันที่ต้องการ",
  "ช่วยให้เห็นภาพการใช้งานได้ชัดขึ้น",
  "เป็นรายละเอียดที่น่าดูสำหรับคนที่ต้องใช้สินค้าแนวนี้",
  "ใส่ทำงานได้ทั้งวัน",
  "เหมาะกับการนั่งออฟฟิศ",
  "อร่อยมาก",
  "กินแล้วติดใจ",
  "ผมกินทุกวัน",
  "ลองแล้วชอบ",
  "ผมใช้",
  "ส่วนตัวชอบ",
  "พอใช้แล้ว",
  "ลองใช้",
  "ใช้แล้วชอบ",
  "General",
  "Lifestyle",
  "Beauty"
];

const SHOPEE_REAL_REVIEW_CTAS = [
  "🛒 กดดูรายละเอียดเพิ่มเติม",
  "🛒 ดูราคาและรายละเอียดเพิ่มเติมได้เลย",
  "🛒 ใครสนใจลองกดดูรายละเอียดได้ครับ"
];

const SHOPEE_HEALTH_PRODUCT_PATTERN =
  /อาหารเสริม|supplement|วิตามิน|vitamin|เวย์|whey|protein|โปรตีน|ผลิตภัณฑ์สุขภาพ|health|สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|เวชสำอาง|cosmeceutical|เครื่องสำอาง|cosmetic|บำรุง|ผิว/i;

const SHOPEE_HEALTH_FORBIDDEN_SNACK_PATTERN =
  /กินเล่น|ของกินเล่น|ขนม|ของว่าง|กินเพลิน|เคี้ยวเพลิน|ทานเล่น/i;

type ShopeeProductInsight = {
  type: string;
  recognized: boolean;
  confidence?: "high" | "medium" | "low";
  productCategory?: string;
  sourceMatches?: Record<"images" | "title" | "description" | "category", boolean>;
  sourceMatchCount?: number;
  safeCaptionMode?: boolean;
  skipReason?: string;
  audience: string;
  situation: string;
  problem: string;
  angle: string;
  fallbackFeatures: string[];
  forbiddenAngles: string[];
};

function randomText(items: string[]) {
  return items[Math.floor(Math.random() * items.length)] ?? items[0] ?? "";
}

function compactProductText(value?: string, max = 92) {
  const normalized = (value ?? "").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? normalized.slice(0, max).replace(/\s+\S*$/, "") + "..." : normalized;
}

function isShopeeHealthSensitiveProduct(product?: ShopeeProductRecord) {
  if (!product) return false;
  return SHOPEE_HEALTH_PRODUCT_PATTERN.test(
    normalizeTextEncoding(`${product.productName} ${product.productDescription || ""} ${product.category || ""}`).toLowerCase()
  );
}

function sanitizeShopeeHealthCaptionText(value: string, product?: ShopeeProductRecord) {
  if (!isShopeeHealthSensitiveProduct(product)) return value;
  return normalizeTextEncoding(value)
    .replace(SHOPEE_HEALTH_FORBIDDEN_SNACK_PATTERN, (match) => {
      if (/ขนม|ของว่าง|กินเล่น|ของกินเล่น|กินเพลิน|เคี้ยวเพลิน|ทานเล่น/i.test(match)) {
        return "ผลิตภัณฑ์ดูแลสุขภาพ";
      }
      return "ผลิตภัณฑ์ดูแลสุขภาพ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function hasShopeeHealthForbiddenSnackText(value: string, product?: ShopeeProductRecord) {
  return isShopeeHealthSensitiveProduct(product) && SHOPEE_HEALTH_FORBIDDEN_SNACK_PATTERN.test(normalizeTextEncoding(value));
}

function decodeShopeeSourceText(value?: string) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getShopeeProductImageSourceText(product: ShopeeProductRecord) {
  const imageUrls = [product.productImageUrl, ...(product.productImageUrls ?? [])]
    .filter((url): url is string => Boolean(url?.trim()));
  return normalizeTextEncoding(
    imageUrls
      .map((url) => decodeShopeeSourceText(url)
        .replace(/^https?:\/\//i, " ")
        .replace(/[/?#=&._%+-]+/g, " "))
      .join(" ")
  );
}

function getShopeeProductSourceTexts(product: ShopeeProductRecord) {
  return {
    images: getShopeeProductImageSourceText(product),
    title: normalizeTextEncoding(product.productName || ""),
    description: normalizeTextEncoding(product.productDescription || ""),
    category: normalizeTextEncoding(getShopeeCategoryLabel(product.category || "") || product.category || "")
  };
}

function hasShopeeProductName(product: ShopeeProductRecord) {
  return Boolean(normalizeTextEncoding(product.productName || "").trim());
}

function hasShopeeProductImage(product: ShopeeProductRecord) {
  return Boolean(product.productImageUrl?.trim() || product.productImageUrls?.some((url) => Boolean(url?.trim())));
}

function getShopeeProductSourceEvidence(product: ShopeeProductRecord, pattern: RegExp) {
  const sourceTexts = getShopeeProductSourceTexts(product);
  const title = pattern.test(sourceTexts.title.toLowerCase());
  const description = pattern.test(sourceTexts.description.toLowerCase());
  const imageTextMatch = pattern.test(sourceTexts.images.toLowerCase());
  const hasImage = hasShopeeProductImage(product);
  const images = imageTextMatch || (hasImage && (title || description));
  // Category is intentionally not used as product-understanding evidence.
  const category = false;
  const sourceMatches = { images, title, description, category };
  const sourceMatchCount = Object.values(sourceMatches).filter(Boolean).length;
  const confidence: ShopeeProductInsight["confidence"] =
    sourceMatchCount >= 3 ? "high" : sourceMatchCount >= 2 ? "medium" : "low";
  return { sourceMatches, sourceMatchCount, confidence };
}

function withShopeeProductEvidence(
  product: ShopeeProductRecord,
  insight: ShopeeProductInsight,
  pattern: RegExp
): ShopeeProductInsight {
  const evidence = getShopeeProductSourceEvidence(product, pattern);
  const hasName = hasShopeeProductName(product);
  const hasImage = hasShopeeProductImage(product);
  return {
    ...insight,
    recognized: Boolean(hasName && hasImage && insight.recognized),
    confidence: evidence.confidence,
    sourceMatches: evidence.sourceMatches,
    sourceMatchCount: evidence.sourceMatchCount,
    safeCaptionMode: evidence.confidence === "low",
    skipReason: !hasName
      ? "SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT: missing product name"
      : !hasImage
        ? "SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT: missing product image"
        : undefined
  };
}

function getShopeeProductInsight(product: ShopeeProductRecord): ShopeeProductInsight {
  const haystack = normalizeTextEncoding(
    [
      product.productName,
      product.productDescription,
      product.category,
      product.productImageUrl,
      ...(product.productImageUrls ?? [])
    ]
      .filter(Boolean)
      .join(" ")
  ).toLowerCase();

  if (/เวย์|whey|protein|โปรตีน/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: "เวย์โปรตีน / อาหารเสริมโปรตีน",
      recognized: true,
      productCategory: "health",
      audience: "คนที่ออกกำลังกายหรืออยากเสริมโปรตีนในแต่ละวัน",
      situation: "ใช้เป็นตัวช่วยจัดโภชนาการหลังออกกำลังกายหรือวันที่กินโปรตีนไม่ถึง",
      problem: "ช่วยให้วางแผนการเสริมโปรตีนได้สะดวกขึ้น",
      angle: "เน้นโปรตีน โภชนาการ ฟิตเนส และความสะดวกในการชง/พกพา โดยไม่อ้างรสชาติหรือผลลัพธ์เกินจริง",
      fallbackFeatures: ["✅ เหมาะกับคนออกกำลังกาย", "✅ ใช้เสริมโปรตีนระหว่างวัน", "✅ ชงดื่มได้สะดวก", "✅ พกไปฟิตเนสได้ง่าย"],
      forbiddenAngles: ["ห้ามเขียนว่าอร่อยมาก", "ห้ามอ้างว่ากินทุกวัน", "ห้ามอ้างว่าลองแล้วชอบ"]
    }, /เวย์|whey|protein|โปรตีน|supplement|อาหารเสริม|ฟิตเนส|fitness/i);
  }

  if (/กีฬา|sports?|ฟิตเนส|วิ่ง|running|แบด|badminton|เทนนิส|tennis|ฟุตบอล|football|yoga|โยคะ|ออกกำลังกาย|ถุงเท้า|กางเกงกีฬา|เสื้อกีฬา|adidas|adizero|nike|yonex/.test(haystack)) {
    const isSock = /ถุงเท้า|sock|quarter\s?socks?|yonex/.test(haystack);
    const isShoe = /รองเท้า|shoe|sneaker|adidas|adizero|nike/.test(haystack);
    return withShopeeProductEvidence(product, {
      type: isSock ? "ถุงเท้ากีฬา" : isShoe ? "รองเท้าวิ่ง / รองเท้ากีฬา" : "สินค้าออกกำลังกาย / กีฬา",
      recognized: true,
      productCategory: "sports",
      audience: "คนที่ออกกำลังกาย เล่นกีฬา วิ่ง ฟิตเนส แบดมินตัน เทนนิส หรือฟุตบอล",
      situation: "ใช้ตอนซ้อม ออกกำลังกาย หรือเล่นกีฬาที่ต้องเคลื่อนไหวบ่อย",
      problem: "ช่วยให้แต่งตัวหรือเตรียมอุปกรณ์สำหรับการเคลื่อนไหวได้เหมาะขึ้น",
      angle: "เน้นความคล่องตัว ความกระชับ การซัพพอร์ตการเคลื่อนไหว และการใช้งานกับกีฬา",
      fallbackFeatures: ["✅ เหมาะกับการออกกำลังกาย", "✅ ช่วยให้เคลื่อนไหวคล่องตัว", "✅ ใช้ได้กับการซ้อมหรือเล่นกีฬา", "✅ ดีไซน์เหมาะกับสายฟิตเนส"],
      forbiddenAngles: ["ห้ามเขียนว่าใส่ทำงานได้ทั้งวัน", "ห้ามเขียนว่าเหมาะกับการนั่งออฟฟิศ"]
    }, /กีฬา|sports?|ฟิตเนส|fitness|วิ่ง|running|run|แบด|badminton|เทนนิส|tennis|ฟุตบอล|football|yoga|โยคะ|ออกกำลังกาย|ถุงเท้า|sock|รองเท้า|shoe|sneaker|adidas|adizero|yonex/i);
  }

  if (/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|บำรุง|ผิว|beauty|cosmetic|cleanser|โฟมล้างหน้า/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: /กันแดด|sunscreen|spf/.test(haystack) ? "กันแดด / สกินแคร์" : /serum|เซรั่ม/.test(haystack) ? "เซรั่ม / สกินแคร์" : "สกินแคร์ / ความงาม",
      recognized: true,
      productCategory: "beauty",
      audience: "คนที่กำลังเลือกสกินแคร์หรือไอเทมดูแลผิวตามคุณสมบัติที่สินค้าแจ้ง",
      situation: "ใช้ใน routine ดูแลผิวหรือพกไว้ใช้ตามความสะดวก",
      problem: "ช่วยให้เลือกผลิตภัณฑ์ดูแลผิวตามส่วนผสมและวิธีใช้งานได้ง่ายขึ้น",
      angle: "เน้นส่วนผสม วิธีใช้ เนื้อสัมผัส ขนาด และความสะดวก ห้ามอ้างผลลัพธ์เกินจริง",
      fallbackFeatures: ["✅ ใช้เป็นส่วนหนึ่งของ routine ดูแลผิวได้", "✅ ขนาดใช้งานสะดวก", "✅ พกหรือวางไว้ใช้หน้าโต๊ะเครื่องแป้งได้ง่าย", "✅ เลือกตามส่วนผสมและวิธีใช้ที่ระบุได้"],
      forbiddenAngles: ["ห้ามเคลมเห็นผลแน่นอน", "ห้ามเขียนว่าหาย 100%", "ห้ามอ้างผลลัพธ์ส่วนตัว"]
    }, /สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|บำรุง|ผิว|beauty|cosmetic|cleanser|โฟมล้างหน้า|d'alba|dalba/i);
  }

  if (/ครัว|kitchen|ทำอาหาร|หม้อ|กระทะ|กล่องอาหาร|ถนอมอาหาร|ช้อน|จาน|แก้ว|ขวดน้ำ|tumbler|กระติก|เก็บความเย็น|เก็บอุณหภูมิ/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: /แก้ว|ขวดน้ำ|tumbler|กระติก|เก็บความเย็น|เก็บอุณหภูมิ/.test(haystack) ? "แก้ว/กระติกเก็บอุณหภูมิ" : "ของใช้ในครัว",
      recognized: true,
      productCategory: "kitchen",
      audience: "คนที่ทำอาหาร จัดเก็บของกิน หรืออยากให้มุมครัวใช้งานสะดวกขึ้น",
      situation: "ใช้ตอนเตรียมอาหาร จัดเก็บ หรือพกเครื่องดื่ม/อาหาร",
      problem: "ช่วยให้การทำครัวหรือจัดเก็บของกินเป็นระเบียบและสะดวกขึ้น",
      angle: "เน้นการประกอบอาหาร การจัดเก็บ ความจุ วัสดุ และความสะดวกในการล้าง/หยิบใช้",
      fallbackFeatures: ["✅ ใช้ในครัวได้สะดวก", "✅ ช่วยจัดเก็บให้เป็นระเบียบ", "✅ ขนาดเข้ากับการเตรียมอาหารหรือจัดเก็บ", "✅ หยิบใช้หรือล้างได้ง่าย"],
      forbiddenAngles: []
    }, /ครัว|kitchen|ทำอาหาร|หม้อ|กระทะ|กล่องอาหาร|ถนอมอาหาร|ช้อน|จาน|แก้ว|ขวดน้ำ|tumbler|cup|bottle|กระติก|เก็บความเย็น|เก็บอุณหภูมิ|stainless/i);
  }

  if (/สัตว์|pet|แมว|cat|สุนัข|dog|อาหารสัตว์|ทรายแมว|ปลอกคอ|ขนสัตว์/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: "สินค้าเกี่ยวกับสัตว์เลี้ยง",
      recognized: true,
      productCategory: "pets",
      audience: "คนเลี้ยงสัตว์ที่ต้องการดูแลความสะอาด อาหาร หรือของใช้ของสัตว์เลี้ยง",
      situation: "ใช้ในบ้านกับสัตว์เลี้ยงเป็นประจำตามประเภทสินค้า",
      problem: "ช่วยให้การดูแลสัตว์เลี้ยงเป็นระบบและสะดวกขึ้น",
      angle: "เน้นการดูแลสัตว์เลี้ยง สุขอนามัย อาหาร และความสะดวกในการเลี้ยง",
      fallbackFeatures: ["✅ เหมาะกับบ้านที่มีสัตว์เลี้ยง", "✅ ช่วยดูแลความสะอาดได้สะดวก", "✅ ใช้งานกับสัตว์เลี้ยงตามประเภทสินค้า", "✅ เก็บหรือหยิบใช้ได้ง่าย"],
      forbiddenAngles: []
    }, /สัตว์|pet|แมว|cat|สุนัข|dog|อาหารสัตว์|ทรายแมว|ปลอกคอ|ขนสัตว์/i);
  }

  if (/บ้าน|home|จัดระเบียบ|เก็บของ|ทำความสะอาด|ไม้ถู|ถังขยะ|ชั้นวาง|กล่องเก็บ/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: "ของใช้ในบ้าน",
      recognized: true,
      productCategory: "home_living",
      audience: "คนที่อยากจัดบ้าน ทำความสะอาด หรือแก้ปัญหาของใช้จุกจิกในบ้าน",
      situation: "ใช้ในบ้าน ห้องน้ำ ห้องครัว หรือมุมจัดเก็บของ",
      problem: "ช่วยให้บ้านเป็นระเบียบ สะอาด หรือหยิบใช้งานได้สะดวกขึ้น",
      angle: "เน้นการใช้งานจริง ความสะดวก การจัดระเบียบ การทำความสะอาด และปัญหาในบ้าน",
      fallbackFeatures: ["✅ ช่วยให้บ้านเป็นระเบียบขึ้น", "✅ ใช้งานในบ้านได้สะดวก", "✅ เหมาะกับมุมที่ต้องหยิบใช้บ่อย", "✅ ช่วยประหยัดพื้นที่หรือเวลา"],
      forbiddenAngles: []
    }, /บ้าน|home|จัดระเบียบ|เก็บของ|ทำความสะอาด|ไม้ถู|ถังขยะ|ชั้นวาง|กล่องเก็บ/i);
  }

  if (/smart\s?watch|สมาร์ทวอทช์|นาฬิกาอัจฉริยะ|นาฬิกา smart|fitness tracker|tracker/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: "สมาร์ทวอทช์ / อุปกรณ์ติดตามสุขภาพ",
      recognized: true,
      productCategory: "mobile_gadgets",
      audience: "คนที่อยากดูข้อมูลการออกกำลังกาย การแจ้งเตือน หรือการใช้งานบนข้อมือ",
      situation: "ใส่ระหว่างออกกำลังกาย เดินทาง หรือใช้เช็กข้อมูลพื้นฐานระหว่างวัน",
      problem: "ช่วยรวมข้อมูลการใช้งานและการแจ้งเตือนไว้บนข้อมือให้ดูง่ายขึ้น",
      angle: "เน้นฟังก์ชันที่ระบุ หน้าจอ แบตเตอรี่ โหมดกีฬา หรือการเชื่อมต่อเท่านั้น",
      fallbackFeatures: ["✅ ดูข้อมูลบนข้อมือได้สะดวก", "✅ เหมาะกับการใส่ติดตัวระหว่างวัน", "✅ เลือกจากฟังก์ชันที่ระบุในสินค้า"],
      forbiddenAngles: ["ห้ามเคลมวัดสุขภาพแม่นยำเกินจริง", "ห้ามอ้างฟีเจอร์ที่สินค้าไม่ได้ระบุ"]
    }, /smart\s?watch|สมาร์ทวอทช์|นาฬิกาอัจฉริยะ|นาฬิกา smart|fitness tracker|tracker|awei|h25/i);
  }

  if (/art\s?toy|อาร์ตทอย|กล่องสุ่ม|blind\s?box|figure|ฟิกเกอร์|โมเดล|ของสะสม|collectible|ตุ๊กตา/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: /กล่องสุ่ม|blind\s?box/.test(haystack) ? "กล่องสุ่ม / Art Toy" : "Art Toy / ของสะสม",
      recognized: true,
      productCategory: "collectibles",
      audience: "คนสะสมฟิกเกอร์ อาร์ตทอย หรือของตกแต่งโต๊ะ/ชั้นโชว์",
      situation: "ใช้สะสม ตั้งโชว์ ถ่ายรูป หรือเติมมุมโต๊ะให้มีคาแรกเตอร์มากขึ้น",
      problem: "ช่วยให้เลือกของสะสมจากซีรีส์ รุ่น หรือดีไซน์ที่ตรงกับสไตล์ได้ชัดขึ้น",
      angle: "เน้นซีรีส์ ดีไซน์ ขนาด วัสดุ รุ่น และลักษณะกล่อง/ตัวละครที่ระบุ",
      fallbackFeatures: ["✅ เหมาะกับสายสะสม", "✅ ตั้งโชว์บนโต๊ะหรือชั้นได้", "✅ เลือกจากซีรีส์หรือดีไซน์ที่ชอบ"],
      forbiddenAngles: ["ห้ามรับประกันตัวลับ", "ห้ามอ้าง rarity ถ้าไม่มีข้อมูล"]
    }, /art\s?toy|อาร์ตทอย|กล่องสุ่ม|blind\s?box|figure|ฟิกเกอร์|โมเดล|ของสะสม|collectible|ตุ๊กตา|yumi/i);
  }

  if (/มือถือ|โทรศัพท์|gadget|แกดเจ็ต|หูฟัง|earbud|speaker|ลำโพง|สายชาร์จ|powerbank|พาวเวอร์แบงค์|charger|ชาร์จ|เคส|tablet|แท็บเล็ต/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: /หูฟัง|earbud|earphone|headphone/.test(haystack) ? "หูฟัง / แกดเจ็ตเสียง" : "มือถือและแกดเจ็ต",
      recognized: true,
      productCategory: "mobile_gadgets",
      audience: "คนที่ใช้อุปกรณ์ไอทีหรืออยากหาแกดเจ็ตเสริมให้ใช้งานสะดวกขึ้น",
      situation: "ใช้กับมือถือ โต๊ะทำงาน การเดินทาง หรือการชาร์จ/ฟังเสียงตามประเภทสินค้า",
      problem: "ช่วยให้เลือกฟังก์ชัน พอร์ต ขนาด หรือความเข้ากันได้กับอุปกรณ์ได้ตรงขึ้น",
      angle: "เน้นสเปก ฟังก์ชัน ความเข้ากันได้ พอร์ต ขนาด และการพกพาที่ระบุ",
      fallbackFeatures: ["✅ ใช้คู่กับอุปกรณ์ไอทีได้", "✅ ดูสเปกและความเข้ากันได้ก่อนเลือก", "✅ ขนาดเหมาะกับการพกหรือวางบนโต๊ะ"],
      forbiddenAngles: ["ห้ามอ้างคุณภาพเสียง/แบตเตอรี่เกินข้อมูล", "ห้ามอ้างรองรับรุ่นที่สินค้าไม่ได้ระบุ"]
    }, /มือถือ|โทรศัพท์|gadget|แกดเจ็ต|หูฟัง|earbud|earphone|headphone|speaker|ลำโพง|สายชาร์จ|powerbank|พาวเวอร์แบงค์|charger|ชาร์จ|เคส|tablet|แท็บเล็ต|bluetooth/i);
  }

  if (/เสื้อ|กางเกง|เดรส|กระโปรง|แฟชั่น|fashion|รองเท้า|shoe|sneaker|แตะ|หมวก|เข็มขัด|กระเป๋า|bag|เป้|คาดอก|wallet/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: /กระเป๋า|bag|เป้|คาดอก|wallet/.test(haystack) ? "กระเป๋า / ไอเทมพกพา" : /รองเท้า|shoe|sneaker/.test(haystack) ? "รองเท้า / แฟชั่น" : "แฟชั่น / เครื่องแต่งกาย",
      recognized: true,
      productCategory: "fashion",
      audience: "คนที่เลือกเสื้อผ้า รองเท้า หรือกระเป๋าตามทรง วัสดุ และโอกาสใช้งาน",
      situation: "ใช้แต่งตัว ออกไปข้างนอก เดินทาง หรือจัดของจำเป็นตามประเภทสินค้า",
      problem: "ช่วยให้เลือกทรง ขนาด ช่องเก็บ หรือดีไซน์ที่เข้ากับการใช้งานได้ง่ายขึ้น",
      angle: "เน้นทรง วัสดุ ไซซ์ ช่องเก็บ การแมตช์ชุด หรือโอกาสใช้งานที่สินค้าแจ้ง",
      fallbackFeatures: ["✅ ทรงและดีไซน์ดูใช้งานง่าย", "✅ เลือกจากขนาดหรือช่องเก็บได้", "✅ เหมาะกับการแต่งตัวหรือพกของตามประเภทสินค้า"],
      forbiddenAngles: ["ห้ามอ้างใส่สบายทั้งวันถ้าไม่มีข้อมูลวัสดุ/ทรงรองรับ"]
    }, /เสื้อ|กางเกง|เดรส|กระโปรง|แฟชั่น|fashion|รองเท้า|shoe|sneaker|แตะ|หมวก|เข็มขัด|กระเป๋า|bag|เป้|คาดอก|wallet|crossbody/i);
  }

  if (!SHOPEE_HEALTH_PRODUCT_PATTERN.test(haystack) && /ขนม|snack|อาหาร(?!เสริม)|food|เครื่องดื่ม|drink|กาแฟ|coffee|ชา|tea|เปี๊ยะ|คุกกี้|เค้ก|น้ำพริก/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: "อาหาร / ขนม / เครื่องดื่ม",
      recognized: true,
      productCategory: "food_beverage",
      audience: "คนที่อยากมีของกิน ของว่าง หรือเครื่องดื่มติดบ้าน/ติดโต๊ะ",
      situation: "เก็บไว้กินเล่น แบ่งกับคนที่บ้าน หรือพกไปกินระหว่างวันตามประเภทสินค้า",
      problem: "ช่วยให้เลือกจากรสชาติ แพ็ก ขนาดบรรจุ หรือวิธีเก็บที่สินค้าแจ้ง",
      angle: "เน้นรส/แพ็ก/จำนวน/ขนาด/วิธีเก็บจากข้อมูลสินค้าเท่านั้น ห้ามอ้างว่าอร่อยถ้าไม่มีข้อมูลรีวิวจริง",
      fallbackFeatures: ["✅ แพ็กเหมาะกับการแบ่งกิน", "✅ ขนาดบรรจุช่วยให้เก็บไว้ได้", "✅ เหมาะกับมีติดบ้านเป็นของว่าง"],
      forbiddenAngles: ["ห้ามเขียนว่าอร่อยมากถ้าข้อมูลสินค้าไม่ได้ระบุ", "ห้ามอ้างว่ากินแล้วติดใจ"]
    }, /ขนม|snack|อาหาร(?!เสริม)|food|เครื่องดื่ม|drink|กาแฟ|coffee|ชา|tea|เปี๊ยะ|คุกกี้|เค้ก|น้ำพริก/i);
  }

  const genericInsight = withShopeeProductEvidence(product, {
    type: "สินค้าไลฟ์สไตล์ / ของใช้ทั่วไป",
    recognized: true,
    productCategory: "general",
    audience: "คนที่ต้องการไอเทมที่ช่วยให้จัดของ ใช้งาน หรือพกติดตัวได้สะดวกขึ้น",
    situation: "ใช้กับมุมบ้าน โต๊ะทำงาน การเดินทาง หรือกิจกรรมที่เห็นได้จากชื่อและรูปสินค้า",
    problem: "ช่วยลดความยุ่งยากเวลาหยิบใช้ จัดเก็บ หรือเตรียมของให้พร้อมขึ้น",
    angle: "เขียนจากการใช้งานที่เห็นได้จริงในชื่อ รูป และ description โดยไม่ยกจำนวน สี ขนาด หรือน้ำหนักเป็นจุดขายหลักถ้าไม่เกี่ยวกับการใช้งาน",
    fallbackFeatures: ["✅ หยิบใช้งานได้ง่ายขึ้น", "✅ ช่วยจัดของหรือเตรียมของให้เป็นระเบียบ", "✅ เหมาะกับการใช้งานตามบริบทในรูปสินค้า"],
    forbiddenAngles: ["ห้ามเดาคุณสมบัติที่ไม่มีในชื่อ รูป หรือ description", "ห้ามใช้คำ generic ลอย ๆ โดยไม่มีบริบทสินค้า"]
  }, /ของใช้|ไอเทม|item|use|portable|พก|จัด|เก็บ|บ้าน|home|desk|โต๊ะ|travel|เดินทาง/i);
  return {
    ...genericInsight,
    safeCaptionMode: true
  };
}

function assertRecognizedShopeeProductInsight(product: ShopeeProductRecord) {
  return getShopeeProductInsight(product);
}

export function getShopeeCaptionProductName(productName?: string) {
  const cleaned = cleanShopeeProductTitleForContent(productName);
  return getShopeeShortReviewProductName(cleaned || productName || TH.defaultProductName);
}

const SHOPEE_PRODUCT_ENTITY_HINT_PATTERN =
  /เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|coway|โคเวย์|water\s?(?:purifier|filter)|ผงซักฟอก|น้ำยาซัก|สเปรย์|ฉีดผ้า|ผ้าหอม|detergent|laundry|ปรับผ้านุ่ม|ซักผ้า|ลดกลิ่นอับ|แก้ว|กระติก|กระบอกน้ำ|ขวดน้ำ|โคมไฟ|ถุงเท้า|รองเท้า|เสื้อ|กระโปรง|เดรส|กางเกง|กล้อง|สร้อย|เครื่องประดับ|อาหารเสริม|วิตามิน|เซรั่ม|กระเป๋า|ขนม|น้ำพริก|ถาดน้ำแข็ง|สัตว์|pet|smart\s?watch|หูฟัง|จัมป์|ยางรถ|ลูกแบด|art\s?toy|กล่องสุ่ม/i;

const SHOPEE_TITLE_NOISE_SEGMENT_PATTERN =
  /^(?:\[[^\]]*\]|\([^)]*\)|[\s|/,-])*(?:ทักแชท|ก่อนสั่งซื้อ|โคดัง|โค้ด|โค๊ด|code|cod|ของพร้อมส่ง|พร้อมส่ง|ส่งฟรี|ฟรีส่ง|flash\s?sale|sale|deal|โปร|ลดราคา|ส่วนลด|ราคาถูก|ถูกมาก|ของแท้|ร้านไทย|เก็บเงินปลายทาง|รับประกันฟรี|รับประกัน|จ่าย\s*\d+|เดือนแรก)(?:[\s\p{L}\p{N}|/,-]*)$/iu;

function stripShopeeMarketplaceNoise(value: string) {
  return normalizeTextEncoding(value)
    .replace(/\[[^\]]*(?:ทักแชท|ก่อนสั่งซื้อ|แถม|โปร|ลด|ส่งฟรี|sale|deal|พร้อมส่ง|โค้ด|โคดัง|code|รับประกัน)[^\]]*\]/giu, " ")
    .replace(/\([^)]*(?:ทักแชท|ก่อนสั่งซื้อ|แถม|โปร|ลด|ส่งฟรี|sale|deal|พร้อมส่ง|โค้ด|โคดัง|code|รับประกัน)[^)]*\)/giu, " ")
    .replace(/\b\d{1,2}\.\d{1,2}\b/giu, " ")
    .replace(/\b(?:flash\s?sale|sale|deal|code)\b/giu, " ")
    .replace(/(?:โคดัง|โค้ด|โค๊ด|โคมตั้ง|โค้ต|โค๊ต)\s*(?:ต่ำ|ส่วนลด|ลด)?/giu, " ")
    .replace(/(?:ของ)?พร้อมส่ง|ส่งฟรี|ฟรีส่ง|เก็บเงินปลายทาง|ของแท้|ร้านไทย|ราคาถูก|ถูกมาก|ทักแชทก่อนสั่งซื้อ|ทักแชท|ก่อนสั่งซื้อ/giu, " ")
    .replace(/(?:ส่วนลด|ลดสูงสุด|ราคาพิเศษ)\s*(?:สูงสุด)?\s*[\d,]*(?:\s*(?:บาท|%|เปอร์เซ็นต์))?/giu, " ")
    .replace(/จ่าย\s*[\d,]+\s*บาท(?:ต่อเดือน)?/giu, " ")
    .replace(/(?:\d+\s*)?เดือนแรก|รับประกัน(?:ฟรี)?\s*\d*\s*ปี?/giu, " ")
    .replace(/[🔥💥⚡🎉💸]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SHOPEE_TITLE_NOISE_WORDS = [
  "โคดัง",
  "โค้ด",
  "โค๊ด",
  "code",
  "cod",
  "พร้อมส่ง",
  "ของพร้อมส่ง",
  "ส่งฟรี",
  "ฟรีส่ง",
  "flash sale",
  "sale",
  "deal",
  "โปร",
  "ลดราคา",
  "ส่วนลด",
  "ลดสูงสุด",
  "ทักแชท",
  "ทักแชทก่อนสั่งซื้อ",
  "ก่อนสั่งซื้อ",
  "รับประกันฟรี",
  "รับประกัน",
  "เดือนแรก",
  "ราคาถูก",
  "ถูกมาก",
  "ของแท้",
  "ร้านไทย",
  "เก็บเงินปลายทาง"
] as const;

function getShopeeCleanedProductTitleInfo(productName?: string) {
  const rawTitle = normalizeTextEncoding(productName ?? "").trim();
  const cleanedTitle = cleanShopeeProductTitleForContent(rawTitle);
  const lowerRawTitle = rawTitle.toLowerCase();
  const removedNoiseWords = SHOPEE_TITLE_NOISE_WORDS.filter((word) => lowerRawTitle.includes(word.toLowerCase()));
  return {
    rawTitle,
    cleanedTitle: cleanedTitle || rawTitle,
    removedNoiseWords
  };
}

export function cleanShopeeProductTitleForContent(productName?: string) {
  const source = normalizeTextEncoding(productName ?? "").trim();
  if (!source) return "";

  const segments = source
    .split(/\s*[|｜]+\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const usefulSegments = segments.length
    ? segments.filter((segment) => {
        const cleanedSegment = stripShopeeMarketplaceNoise(segment);
        if (!cleanedSegment) return false;
        if (SHOPEE_TITLE_NOISE_SEGMENT_PATTERN.test(segment) && !SHOPEE_PRODUCT_ENTITY_HINT_PATTERN.test(segment)) return false;
        return true;
      })
    : [source];

  const cleaned = stripShopeeMarketplaceNoise(usefulSegments.join(" "));
  return compactProductText(cleaned || stripShopeeMarketplaceNoise(source), 140);
}

function getShopeeShortReviewProductName(productName?: string) {
  const source = cleanShopeeProductTitleForContent(productName) || normalizeTextEncoding(productName ?? TH.defaultProductName)
    .replace(/^\s*\[[^\]]*\]\s*/g, "")
    .replace(/(?:ส่งฟรี|พร้อมส่ง|ของแท้|แท้|ลดราคา|โปร|sale|deal|รุ่นใหม่ล่าสุด|ใหม่ล่าสุด)/giu, " ")
    .replace(/\b[A-Z]{1,4}[-_]?\d{2,}\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const haystack = source.toLowerCase();
  const reviewNameRules: Array<[RegExp, () => string]> = [
    [/แก้วเพชร/iu, () => /หลอด/.test(haystack) ? "แก้วเพชรเก็บความเย็นพร้อมหลอด 🥤" : "แก้วเพชรเก็บความเย็นพกพา 🥤"],
    [/กระติกน้ำ/iu, () => /ใหญ่|จุ|ลิตร/.test(haystack) ? "กระติกน้ำเก็บอุณหภูมิขนาดใหญ่ 🥤" : "กระติกน้ำเก็บความเย็นพกพา 🥤"],
    [/แก้ว|tumbler|cup/iu, () => /หลอด|straw/.test(haystack) ? "แก้วเก็บอุณหภูมิพร้อมหลอด 🥤" : "แก้วเก็บความเย็นพกพา 🥤"],
    [/โคมไฟ\s*LED|โคมไฟ|lamp|light/iu, () => /อ่าน|หนังสือ|ถนอม|ตา/.test(haystack) ? "โคมไฟตั้งโต๊ะถนอมสายตา 💡" : /ปรับ|ระดับ|แสง/.test(haystack) ? "โคมไฟอ่านหนังสือปรับแสงได้ 💡" : "โคมไฟอ่านหนังสือถนอมสายตา 💡"],
    [/ถุงเท้า|sock/iu, () => /yonex/.test(haystack) ? "ถุงเท้ากีฬากระชับเท้า YONEX 🏃" : /วิ่ง|running/.test(haystack) ? "ถุงเท้าสำหรับวิ่งและออกกำลังกาย 🏃" : "ถุงเท้ากีฬาระบายอากาศ 🏃"],
    [/สร้อย|สร้อยคอ|necklace|จี้|pendant|เครื่องประดับ|jewelry/iu, () => /จี้|pendant/.test(haystack) ? "สร้อยคอพร้อมจี้สไตล์หรู 💎" : "สร้อยคอแฟชั่นลุคเรียบหรู 💎"],
    [/แหวน|ring/iu, () => "แหวนแฟชั่นแต่งลุคเรียบหรู 💎"],
    [/กำไล|bracelet|bangle/iu, () => "กำไลแฟชั่นแมตช์ง่าย 💎"],
    [/ต่างหู|earring/iu, () => /โบฮีเมียน|boho|bohemian/.test(haystack) ? "ต่างหูโบฮีเมียนแต่งลาย ✨" : "ต่างหูแฟชั่นสไตล์วินเทจ ✨"],
    [/พัดลมพกพา|fan/iu, () => "พัดลมพกพาชาร์จ USB 🌀"],
    [/สมาร์ทวอทช์|smart\s*watch|watch/iu, () => /awei/.test(haystack) ? "สมาร์ทวอทช์ฟังก์ชันครบ Awei ⌚" : "สมาร์ทวอทช์ฟังก์ชันครบ ⌚"],
    [/เวย์โปรตีน|whey|protein/iu, () => "เวย์โปรตีนชงดื่มหลังออกกำลังกาย 💚"],
    [/ไหมขัดฟัน|floss/iu, () => "ไหมขัดฟันด้ามจับใช้ง่าย 🦷"],
    [/เซรั่ม|serum/iu, () => "เซรั่มบำรุงผิวใช้ประจำวัน ✨"],
    [/กันแดด|sunscreen|spf/iu, () => "กันแดดเนื้อบางเบาใช้ทุกวัน ✨"],
    [/กระเป๋า|bag/iu, () => /คาดอก|crossbody/.test(haystack) ? "กระเป๋าคาดอกจัดของพกพา 🎒" : "กระเป๋าพกพาช่องเก็บของเยอะ 🎒"],
    [/รองเท้า|shoe|sneaker|adizero|adidas/iu, () => /adidas|adizero/.test(haystack) ? "รองเท้าวิ่งน้ำหนักเบา Adidas 👟" : /วิ่ง|running|run/.test(haystack) ? "รองเท้าวิ่งน้ำหนักเบา 👟" : "รองเท้ากีฬาใส่เดินสบาย 👟"]
  ];

  for (const [pattern, buildName] of reviewNameRules) {
    if (pattern.test(source)) return compactProductText(buildName(), 58);
  }

  const firstUsefulChunk = source
    .split(/\s*(?:[|/,:;]+|\s+-\s+|รุ่น|พร้อม|สำหรับ|แบบ|ขนาด|ความจุ|สี|ลาย|แพ็ก|เซ็ต|x\s*\d+)\s*/iu)
    .map((part) => part.trim())
    .find((part) => part.length >= 2) || source;

  const withoutSpecs = firstUsefulChunk
    .replace(/\b\d+(?:\.\d+)?\s*(?:ml|มล|ลิตร|oz|cm|ซม|kg|กก|กรัม|g|ชิ้น|pcs|w|v)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = withoutSpecs.split(/\s+/).filter(Boolean);
  const shortName = words.length > 4 ? words.slice(0, 4).join(" ") : withoutSpecs;
  const genericShortNames = /^(?:กระติกน้ำ|แก้วน้ำ|แก้ว|โคมไฟ|ถุงเท้า|ต่างหู|กระเป๋า|รองเท้า)$/iu;
  const improvedName = genericShortNames.test(shortName)
    ? `${shortName}ใช้งานประจำวัน ✨`
    : shortName;
  return compactProductText(improvedName || source || TH.defaultProductName, 58);
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

function enforceAndAssertShopeeCaptionTitleOnce(caption: string, _captionProductName?: string, _fullProductName?: string) {
  return normalizeTextEncoding(caption).trim();
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
  const withoutHardSell = SHOPEE_HARD_SELL_PATTERNS.reduce((value, pattern) => value.replace(pattern, ""), caption);
  const withoutGeneric = SHOPEE_FORBIDDEN_GENERIC_PHRASES.reduce(
    (value, phrase) => value.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), ""),
    withoutHardSell
  );
  return withoutGeneric
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SHOPEE_UNCLEAR_IMAGE_TEXT_PATTERN =
  /[\uFFFD\u25CC]|(?:[่้๊๋ัิีึืุู็์]\s*){2,}|(?:[ก-๙]{1,2}\s+){3,}[ก-๙]{1,2}/u;

const SHOPEE_PUBLIC_SOURCE_LANGUAGE_PATTERN =
  /ชื่อสินค้า|รูปสินค้า|ภาพสินค้า|จากภาพ|จากชื่อ|จากข้อมูล|จากรายละเอียดสินค้า|จากคำอธิบายสินค้า|ตามภาพ|ตามข้อมูล|อ้างอิงจาก|กระบวนการวิเคราะห์|วิเคราะห์จาก|ดูจากข้อมูล|ตรวจสเปก|ตรวจรายละเอียด/iu;

function isUnclearShopeeImageTextLine(value?: string) {
  const normalized = normalizeTextEncoding(value ?? "").trim();
  if (!normalized) return false;
  if (SHOPEE_UNCLEAR_IMAGE_TEXT_PATTERN.test(normalized)) return true;
  const thaiLetterRuns = normalized.match(/[ก-๙]+/gu) ?? [];
  const tinyRuns = thaiLetterRuns.filter((part) => part.length <= 2).length;
  return thaiLetterRuns.length >= 4 && tinyRuns / thaiLetterRuns.length > 0.7;
}

function removeUnclearAndSourceLanguageLines(caption: string, product?: ShopeeProductRecord) {
  return normalizeTextEncoding(caption)
    .split(/\r?\n/)
    .filter((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (index === 0) return true;
      if (/^(?:💰|🛒|📍|#)/u.test(trimmed)) return true;
      if (SHOPEE_PUBLIC_SOURCE_LANGUAGE_PATTERN.test(trimmed)) return false;
      if (isUnclearShopeeImageTextLine(trimmed)) return false;
      if (containsForbiddenShopeeGenericText(trimmed, product)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assertShopeeCaptionHasNoUnclearOrSourceLanguage(caption: string, product?: ShopeeProductRecord) {
  // Deprecated legacy guard: Storyboard captions use validateStoryboardAffiliateCaption().
  // Keep this as a non-throwing sanitizer so old call sites cannot skip products with stale rules.
  return removeUnclearAndSourceLanguageLines(caption, product);
}

function hasShopeeProductSpecificContext(value: string, product?: ShopeeProductRecord) {
  const normalized = normalizeTextEncoding(value).toLowerCase();
  const productText = normalizeTextEncoding(
    [
      product?.productName,
      product?.productDescription,
      product?.category,
      stringifyShopeeMetadataValue((product as ShopeeProductRecord & Record<string, unknown> | undefined)?.attributes).join(" "),
      stringifyShopeeMetadataValue((product as ShopeeProductRecord & Record<string, unknown> | undefined)?.specifications).join(" ")
    ]
      .filter(Boolean)
      .join(" ")
  ).toLowerCase();
  const productTokens = productText
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, "").trim())
    .filter((token) => token.length >= 3 && !isGenericShopeeCategoryText(token));
  const matchedProductTokens = productTokens.filter((token) => normalized.includes(token)).length;
  const contextWords = [
    "กีฬา",
    "ฟิตเนส",
    "โปรตีน",
    "ผิว",
    "ครัว",
    "สัตว์เลี้ยง",
    "ซักผ้า",
    "ช่องเก็บ",
    "วัสดุ",
    "ขนาด",
    "ความจุ",
    "กลิ่น",
    "ไซซ์",
    "สาย",
    "ซิป",
    "แบต",
    "พอร์ต",
    "ฟังก์ชัน",
    "แพ็ก",
    "รุ่น",
    "ซีรีส์"
  ];
  return matchedProductTokens >= 1 || contextWords.some((word) => normalized.includes(word));
}

function containsForbiddenShopeeGenericText(value?: string, product?: ShopeeProductRecord) {
  const normalized = normalizeTextEncoding(value ?? "").toLowerCase();
  if (!normalized) return false;
  if (hasShopeeHealthForbiddenSnackText(normalized, product)) return true;
  if (SHOPEE_FORBIDDEN_GENERIC_PHRASES.some((phrase) => normalized.includes(phrase.toLowerCase()))) {
    return true;
  }
  return SHOPEE_CONTEXTLESS_GENERIC_PHRASES.some((phrase) => {
    if (!normalized.includes(phrase.toLowerCase())) return false;
    return !hasShopeeProductSpecificContext(normalized, product);
  });
}

function isBadShopeeFact(value?: string, product?: ShopeeProductRecord) {
  const normalized = normalizeTextEncoding(value ?? "").trim();
  if (!normalized) return true;
  if (containsForbiddenShopeeGenericText(normalized, product)) return true;
  if (SHOPEE_MARKETPLACE_METRIC_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (isCategoryLikeShopeeFeature(normalized, product)) return true;
  if (isSimilarToShopeeProductName(normalized, product?.productName, 0.7)) return true;
  return false;
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
  const titleTokens = cleanShopeeProductTitleForContent(product.productName)
    .split(/[\s/|,()[\]{}]+/)
    .map((part) => part.replace(/[^\p{L}\p{N}_-]/gu, "").trim())
    .filter((part) => part.length >= 3 && !isGenericShopeeCategoryText(part) && !stripShopeeMarketplaceNoise(part).match(/^$/))
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
  return /(ลองดู|สนใจ|รายละเอียด|ลิงก์|ลิงค์|เพิ่มเติม|ด้านล่าง|กดดู|พิกัด|ราคา|โปร|Shopee|shopee|ดูได้|ดูตัวนี้|ได้ที่|เช็กโปร|รีวิว|หน้าสินค้า)/i.test(normalizeTextEncoding(caption));
}

function formatShopeePrice(product?: ShopeeProductRecord) {
  const price = product?.discountPrice || product?.productPrice;
  if (!price || !Number.isFinite(price)) return "";
  return `💰 ราคาโปร ${new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(price)} บาท`;
}

function isCategoryLikeShopeeFeature(value?: string, product?: ShopeeProductRecord) {
  const cleaned = normalizeTextEncoding(value ?? "")
    .replace(/^[*•\-✅\s]+/u, "")
    .replace(/^#+/, "")
    .replace(/^(เหมาะกับหมวด|หมวด|หมวดหมู่|category)\s*[:：]?\s*/i, "")
    .trim();
  if (!cleaned) return true;
  if (/^(เหมาะกับหมวด|หมวด|หมวดหมู่|category|general|lifestyle|beauty|home|product)$/i.test(cleaned)) return true;
  if (isGenericShopeeCategoryText(cleaned)) return true;
  if (product?.category && cleaned.toLowerCase() === product.category.trim().toLowerCase()) return true;
  return false;
}

function isRawShopeeSpecWithoutUsageBenefit(value?: string) {
  const cleaned = normalizeTextEncoding(value ?? "")
    .replace(/^[*•\-✅\s]+/u, "")
    .trim();
  if (!cleaned) return true;

  const rawSpecOnlyPatterns = [
    /^(?:sku|รหัส|รุ่น|model)\s*[:：]?\s*[\p{L}\p{N}\s._-]{1,40}$/iu,
    /^(?:สี|color)\s*[:：]?\s*[\p{L}\p{N}\s,/-]{1,50}$/iu,
    /^(?:ขนาด|size|น้ำหนัก|weight)\s*[:：]?\s*[\d.,]+\s*(?:ซม\.?|cm|มม\.?|mm|กก\.?|kg|กรัม|g|ml|มล\.?)?$/iu,
    /^(?:จำนวน|quantity|แพ็ก|pack)\s*[:：]?\s*[\d.,]+\s*(?:ชิ้น|pcs?|ขวด|ซอง|คู่|แพ็ก|กล่อง)?$/iu,
    /^[\d.,]+\s*(?:ชิ้น|pcs?|ขวด|ซอง|คู่|แพ็ก|กล่อง|cm|ซม\.?|kg|กก\.?|กรัม|g|ml|มล\.?)$/iu
  ];

  if (!rawSpecOnlyPatterns.some((pattern) => pattern.test(cleaned))) return false;
  return !/(พก|หยิบ|จัดเก็บ|อ่าน|ทำงาน|ออกกำลังกาย|ฟิตเนส|วิ่ง|กีฬา|ครัว|ซัก|ระบาย|ชาร์จ|ใช้งาน|สะดวก|ง่าย|เหมาะ|ช่วย)/iu.test(cleaned);
}

function rewriteRawShopeeSpecToBenefit(value: string, product?: ShopeeProductRecord) {
  const cleaned = normalizeTextEncoding(value)
    .replace(/^[*•\-✅\s]+/u, "")
    .replace(/^(จุดเด่น|รายละเอียด|feature|detail)\s*[:：]?\s*/i, "")
    .trim();
  const haystack = normalizeTextEncoding(`${product?.productName ?? ""} ${product?.productDescription ?? ""} ${product?.category ?? ""}`).toLowerCase();
  const lower = cleaned.toLowerCase();

  if (/ความจุ\s*[\d.,]+\s*(?:ml|มล\.?|l|ลิตร|oz)/iu.test(cleaned) || /^[\d.,]+\s*(?:ml|มล\.?|l|ลิตร|oz)$/iu.test(cleaned)) {
    if (/แก้ว|ขวด|tumbler|กระบอก|น้ำ/.test(haystack)) return "เติมครั้งเดียวไม่ต้องเดินเติมน้ำบ่อย";
    if (/กล่อง|กระเป๋า|storage|box/.test(haystack)) return "ใส่ของที่ต้องใช้บ่อยได้พอดี ไม่ต้องแยกหลายชิ้น";
    return "ใช้งานครั้งหนึ่งได้ต่อเนื่อง ไม่ต้องเติมหรือเปลี่ยนบ่อย";
  }

  if (/น้ำหนักเบา|lightweight/i.test(cleaned)) {
    if (/กระเป๋า|bag|เป้|คาดอก|รองเท้า|shoe|พัดลม|แก้ว|ขวด/.test(haystack)) return "พกออกจากบ้านได้ง่าย ไม่รู้สึกเกะกะ";
    return "หยิบใช้งานหรือย้ายที่ได้ง่าย";
  }

  if (/วัสดุคุณภาพดี|วัสดุดี|quality material|premium material/i.test(cleaned)) {
    return "ใช้งานทุกวันแล้วไม่ต้องกังวลเรื่องความทนทาน";
  }

  if (/รูปทรงสวย|ดีไซน์สวย|ทรงสวย|design/i.test(cleaned)) {
    if (/โต๊ะ|บ้าน|ห้อง|โคม|แก้ว|ขวด|กระเป๋า/.test(haystack)) return "วางหรือพกใช้งานแล้วเข้ากับมุมใช้งานได้ง่าย";
    return "ใช้แล้วดูเรียบร้อย ไม่ดูเกะกะ";
  }

  if (/ปรับได้\s*\d+\s*(?:โทน|สี|ระดับ|mode|โหมด)/iu.test(cleaned)) {
    if (/โคม|lamp|ไฟ|แสง/.test(haystack)) return "ปรับแสงให้เข้ากับการอ่านหนังสือหรือทำงานตอนกลางคืนได้ง่าย";
    if (/พัดลม|fan/.test(haystack)) return "ปรับแรงลมให้เข้ากับอากาศแต่ละช่วงได้ง่าย";
    return "ปรับให้เข้ากับการใช้งานแต่ละจังหวะได้ง่าย";
  }
  if (/(?:\d+\+?\s*)?(?:โหมดกีฬา|sports?\s*mode|exercise\s*mode)/iu.test(cleaned)) {
    return "ใช้ออกกำลังกายได้หลายประเภทโดยไม่ต้องเปลี่ยนอุปกรณ์";
  }
  if (/polyester|โพลีเอสเตอร์|ผ้า\s*poly/i.test(cleaned)) {
    return "ระบายอากาศได้ดี ใส่ออกกำลังกายแล้วไม่อับง่าย";
  }
  if (/nylon|ไนลอน/i.test(cleaned)) {
    return /กระเป๋า|bag|เป้|คาดอก/.test(haystack)
      ? "พกของออกจากบ้านได้อุ่นใจขึ้น ดูแลทำความสะอาดไม่ยุ่งยาก"
      : "หยิบใช้บ่อยได้โดยไม่ต้องดูแลยาก";
  }
  if (/สแตนเลส|stainless|304/i.test(cleaned)) {
    return /แก้ว|ขวด|tumbler/.test(haystack)
      ? "ใช้ทุกวันแล้วล้างง่าย ไม่ค่อยมีกลิ่นติดขวด"
      : "ใช้งานทุกวันแล้วไม่ต้องกังวลเรื่องความทนทาน";
  }
  if (/กันน้ำ|waterproof|water resistant/i.test(cleaned)) {
    return "ใช้งานเวลาเดินทางหรือเจอละอองน้ำได้อุ่นใจขึ้น";
  }
  if (/ซิป|zipper/i.test(cleaned)) {
    return "เปิดปิดง่ายและช่วยเก็บของให้เป็นระเบียบ";
  }
  if (/ช่องเก็บ|ช่องจัดเก็บ|compartment/i.test(cleaned)) {
    return "แยกของจุกจิกให้หยิบง่าย ไม่ปนกันในกระเป๋า";
  }
  if (/แบต|battery|mah/i.test(cleaned)) {
    return "เหมาะกับการพกใช้งานนอกบ้านโดยไม่ต้องชาร์จบ่อย";
  }
  if (/พอร์ต|usb|type-?c|ชาร์จ/i.test(cleaned)) {
    return "ต่อใช้งานหรือชาร์จกับอุปกรณ์ประจำวันได้สะดวก";
  }
  if (/ล้างง่าย|ทำความสะอาดง่าย/i.test(cleaned)) {
    return "ล้างง่าย ไม่เสียเวลาหลังใช้งาน";
  }
  if (/พกง่าย|พกพา|portable/i.test(cleaned)) {
    return "พกออกจากบ้านตอนเช้าได้ทั้งวัน";
  }
  if (/จัดเก็บง่าย|เก็บง่าย/i.test(cleaned)) {
    return "เก็บเข้าที่ง่าย ไม่กินพื้นที่หลังใช้งาน";
  }
  if (/ติดแน่น|ยึดแน่น|กาว/i.test(cleaned)) {
    return "ติดใช้งานแล้วไม่หลุดง่าย";
  }

  if (/^(?:ความจุ|วัสดุ|ขนาด|น้ำหนัก|สี|รุ่น|sku|model|ผลิตจาก|ทำจาก|made of)\b/i.test(lower)) return "";

  if (isRawShopeeSpecWithoutUsageBenefit(cleaned)) return "";
  return cleaned;
}

function normalizeShopeeBullet(value: string, max = 86, product?: ShopeeProductRecord) {
  const benefitText = rewriteRawShopeeSpecToBenefit(value, product);
  const cleaned = compactProductText(
    normalizeTextEncoding(value)
      .replace(/^[*•\-✅\s]+/u, "")
      .replace(/^(จุดเด่น|รายละเอียด|feature|detail)\s*[:：]?\s*/i, "")
      .trim(),
    max
  );
  const rewritten = compactProductText(benefitText || cleaned, max);
  if (isBadShopeeFact(rewritten, product)) return "";
  if (isRawShopeeSpecWithoutUsageBenefit(rewritten)) return "";
  return `✅ ${rewritten}`;
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
  const descriptionParts = normalizeTextEncoding(product.productDescription || "")
    .split(/\r?\n|[.!?。]|[ฯๆ]/)
    .map((part) => compactProductText(stripShopeeProductNameFromText(part, productName), 86))
    .filter((part): part is string => Boolean(part) && !isBadShopeeFact(part, product));
  const metadataParts = ["productFeatures", "features", "specifications", "specs", "attributes", "variants"]
    .flatMap((key) => stringifyShopeeMetadataValue(record[key]))
    .map((part) => compactProductText(stripShopeeProductNameFromText(part, productName), 86))
    .filter((part): part is string => Boolean(part) && !isBadShopeeFact(part, product));

  const facts = Array.from(
    new Set(
      [...descriptionParts, ...metadataParts]
        .map((item) => normalizeShopeeBullet(item, 86, product))
        .filter((item): item is string => Boolean(item) && !isShopeeProductNameDuplicateText(item, productName))
    )
  );

  return rotateShopeeFacts(facts, product).slice(0, Math.min(4, facts.length));
}

export function normalizeShopeeCaptionLinkLine(caption: string, shopeeShortUrl?: string) {
  const preferredShortLink = shopeeShortUrl?.trim();
  return normalizeTextEncoding(caption)
    .replace(/📍\s*พิกัด\s*\r?\n\s*(https:\/\/s\.shopee\.co\.th\/\S+)/giu, "📍 พิกัด $1")
    .replace(/📍\s*พิกัด\s+(https:\/\/s\.shopee\.co\.th\/\S+)/giu, "📍 พิกัด $1")
    .replace(/📍\s*พิกัด\s*$/gimu, preferredShortLink ? `📍 พิกัด ${preferredShortLink}` : "📍 พิกัด")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatShopeeShortLinkLine(shopeeShortUrl: string) {
  return `📍 พิกัด ${shopeeShortUrl.trim()}`;
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
  return normalizeTextEncoding(value).replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function buildShopeeProductHook(product: ShopeeProductRecord) {
  const insight = getShopeeProductInsight(product);
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""} ${product.category || ""}`).toLowerCase();
  const options = (() => {
    if (/ไหมขัดฟัน|floss|dental|ช่องปาก|ฟัน/.test(haystack)) return ["เหมาะกับคนที่อยากดูแลซอกฟันให้สะดวกขึ้น", "แพ็กแบบนี้ช่วยให้หยิบใช้หลังแปรงฟันได้ง่าย"];
    if (/กางเกง|short|sportswear|วิ่ง|กีฬา|ฟิตเนส|แบด|เทนนิส|ฟุตบอล/.test(haystack)) return ["เหมาะสำหรับใส่ออกกำลังกายหรือเล่นกีฬา ช่วยให้เคลื่อนไหวได้คล่องตัว", "เน้นความกระชับและความคล่องตัวสำหรับสายกีฬา"];
    if (/เวย์|whey|protein|โปรตีน|อาหารเสริม|supplement|วิตามิน|vitamin/.test(haystack)) return ["เหมาะกับคนที่ต้องการเสริมโปรตีนหรือดูแลโภชนาการในแต่ละวัน", "เหมาะกับสายฟิตเนสที่อยากจัดโปรตีนให้เป็นระบบขึ้น"];
    if (/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|บำรุง|ผิว|beauty/.test(haystack)) return ["เหมาะกับคนที่อยากเติมไอเทมดูแลผิวไว้ใน routine", "ขนาดและรูปแบบใช้งานง่าย เหมาะกับการวางไว้หยิบใช้หน้าโต๊ะเครื่องแป้ง"];
    if (/แก้ว|tumbler|เก็บความเย็น|น้ำแข็ง|ขวดน้ำ/.test(haystack)) return ["เหมาะกับคนที่ต้องพกเครื่องดื่มไว้ระหว่างวัน", "ขนาดและรูปแบบตอบโจทย์การพกน้ำไปทำงานหรือออกไปข้างนอก"];
    if (/กระเป๋า|bag|เป้|คาดอก|wallet/.test(haystack)) return ["เหมาะกับคนที่อยากจัดของจุกจิกให้หยิบง่ายเวลาออกจากบ้าน", "ช่องเก็บและรูปทรงช่วยให้พกของจำเป็นได้เป็นระเบียบขึ้น"];
    if (/พัดลม|fan|ระบายอากาศ/.test(haystack)) return ["เหมาะกับวันที่ต้องการลมช่วยระบายอากาศแบบพกพา", "ขนาดและฟังก์ชันออกแบบมาให้ใช้ในพื้นที่ส่วนตัวได้สะดวก"];
    if (/รองเท้า|shoe|sneaker|แตะ/.test(haystack)) return ["เหมาะกับการใส่เดินหรือทำกิจกรรมตามดีไซน์ของรองเท้า", "รูปทรงและวัสดุช่วยให้เลือกใช้งานได้ตรงกับกิจกรรมมากขึ้น"];
    if (!SHOPEE_HEALTH_PRODUCT_PATTERN.test(haystack) && /ขนม|snack|อาหาร(?!เสริม)|เปี๊ยะ|คุกกี้|เค้ก/.test(haystack)) return ["แพ็กและขนาดเหมาะกับการแบ่งกินหรือเก็บไว้เป็นของว่าง", "เหมาะกับคนที่อยากมีของว่างติดบ้านแบบหยิบง่าย"];
    return [
      insight.situation,
      insight.problem,
      "ถ้ากำลังหาไอเทมแนวนี้ รายละเอียดหลักดูครบพอให้ตัดสินใจง่ายขึ้น"
    ];
  })();
  const chosen = compactProductText(randomText(options), 110);
  return isBadShopeeFact(chosen, product) ? compactProductText(insight.problem, 110) : chosen;
}

function buildShopeeReviewFeeling(product: ShopeeProductRecord) {
  const insight = getShopeeProductInsight(product);
  const facts = collectShopeeProductFacts(product).map((line) => stripShopeeLeadingEmoji(line)).filter((line) => !isBadShopeeFact(line, product));
  const primaryFact = facts[0];
  const templates = primaryFact
    ? [
        `${primaryFact} ช่วยให้หยิบใช้ในสถานการณ์นี้ได้สะดวกขึ้น`,
        `${primaryFact} เข้ากับการใช้งานแบบ ${insight.situation}`,
        `${primaryFact} เป็นจุดที่ช่วยให้ใช้งานได้คล่องขึ้น`
      ]
    : [
        insight.problem,
        insight.situation,
        insight.angle
      ];
  const selected = compactProductText(randomText(templates), 170);
  return containsForbiddenShopeeGenericText(selected, product) ? compactProductText(insight.problem, 170) : selected;
}

function buildShopeeUsageSituation(product: ShopeeProductRecord) {
  const insight = getShopeeProductInsight(product);
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""} ${product.category || ""}`).toLowerCase();
  const options = (() => {
    if (/ไหมขัดฟัน|floss|dental|ช่องปาก|ฟัน/.test(haystack)) return ["วางไว้ในห้องน้ำแล้วหยิบใช้หลังแปรงฟันได้ง่ายขึ้น"];
    if (/กางเกง|short|sportswear|วิ่ง|กีฬา|ฟิตเนส|แบด|เทนนิส|ฟุตบอล/.test(haystack)) return ["เหมาะกับการใส่ไปวิ่ง ฟิตเนส หรือเล่นกีฬาที่ต้องขยับตัวบ่อย"];
    if (/เวย์|whey|protein|โปรตีน|อาหารเสริม|supplement|วิตามิน|vitamin/.test(haystack)) return ["เหมาะกับการจัด routine โภชนาการหรือเสริมโปรตีนควบคู่กับการออกกำลังกาย"];
    if (/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|บำรุง|ผิว|beauty/.test(haystack)) return ["เหมาะกับการเลือกใช้ใน routine ดูแลผิวตามส่วนผสมและวิธีใช้ที่สินค้าแจ้ง"];
    if (/แก้ว|tumbler|เก็บความเย็น|น้ำแข็ง|ขวดน้ำ/.test(haystack)) return ["พกไปทำงานหรือวางไว้บนโต๊ะทั้งวันแล้วหยิบดื่มได้เรื่อย ๆ"];
    if (/กระเป๋า|bag|เป้|คาดอก|wallet/.test(haystack)) return ["สะพายออกไปข้างนอกแล้วของจุกจิกอยู่เป็นที่ หยิบง่ายกว่าเดิม"];
    if (/พัดลม|fan|ระบายอากาศ/.test(haystack)) return ["พกติดโต๊ะทำงานหรือใส่กระเป๋าไว้ วันที่ร้อน ๆ ช่วยได้เยอะ"];
    if (/รองเท้า|shoe|sneaker|แตะ/.test(haystack)) return ["ใส่เดินเล่นหรือออกไปทำธุระได้ง่าย แมตช์กับชุดประจำวันได้สบาย"];
    if (!SHOPEE_HEALTH_PRODUCT_PATTERN.test(haystack) && /ขนม|snack|อาหาร(?!เสริม)|เปี๊ยะ|คุกกี้|เค้ก/.test(haystack)) return ["แยกไว้กินเล่นหรือแบ่งกับคนที่บ้านได้ง่าย เหมาะกับช่วงอยากมีของว่างติดไว้"];
    return [insight.situation];
  })();
  const selected = compactProductText(randomText(options), 150);
  return containsForbiddenShopeeGenericText(selected, product) ? compactProductText(insight.situation, 150) : selected;
}

function buildShopeeDetailBullets(product: ShopeeProductRecord) {
  const facts = collectShopeeProductFacts(product).slice(0, 4);
  if (facts.length >= 2) return facts;
  const insight = getShopeeProductInsight(product);
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""} ${product.category || ""}`).toLowerCase();
  const fallbackFacts: string[] = [];
  if (/เวย์|whey|protein|โปรตีน/.test(haystack)) fallbackFacts.push("✅ เหมาะกับการเสริมโปรตีน", "✅ ใช้ประกอบ routine ฟิตเนสได้", "✅ ช่วยวางแผนโภชนาการได้สะดวก");
  if (/วิตามิน|supplement|vitamin/.test(haystack)) fallbackFacts.push("✅ เหมาะกับ routine ดูแลโภชนาการ", "✅ ขนาดบรรจุช่วยให้จัดเก็บง่าย", "✅ พกหรือวางไว้หยิบทานตามคำแนะนำบนฉลากได้");
  if (/กางเกง|short|sportswear|วิ่ง|กีฬา|ฟิตเนส|แบด|เทนนิส|ฟุตบอล/.test(haystack)) fallbackFacts.push("✅ เหมาะกับการออกกำลังกายหรือเล่นกีฬา", "✅ ช่วยให้เคลื่อนไหวได้คล่องตัว", "✅ ดีไซน์เข้ากับกิจกรรมที่ต้องขยับตัว");
  if (/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|บำรุง|ผิว|beauty/.test(haystack)) fallbackFacts.push("✅ ใช้เป็นส่วนหนึ่งของ routine ดูแลผิวได้", "✅ ขนาดหรือรูปแบบหยิบใช้งานสะดวก", "✅ เหมาะกับการวางไว้ใช้หน้าโต๊ะเครื่องแป้ง");
  if (!SHOPEE_HEALTH_PRODUCT_PATTERN.test(haystack) && /ขนม|snack|เปี๊ยะ|อาหาร(?!เสริม)/.test(haystack)) fallbackFacts.push("✅ แพ็กแบ่งกินง่าย", "✅ ขนาดกำลังดีสำหรับเก็บเป็นของว่าง", "✅ เหมาะกับแบ่งไว้กินหลายรอบ");
  if (/แก้ว|tumbler|ขวดน้ำ/.test(haystack)) fallbackFacts.push("✅ ความจุใช้ได้ทั้งวัน", "✅ จับถนัดมือ", "✅ พกออกไปข้างนอกสะดวก");
  const fallbackFromInsight = insight.fallbackFeatures.filter((line) => !containsForbiddenShopeeGenericText(line, product));
  return Array.from(new Set([...facts, ...fallbackFacts, ...fallbackFromInsight].filter((line) => !isBadShopeeFact(stripShopeeLeadingEmoji(line), product)))).slice(0, 4);
}

function getShopeeShortReviewEmoji(product: ShopeeProductRecord) {
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""} ${product.category || ""}`).toLowerCase();
  if (/แก้ว|ขวดน้ำ|กระติก|tumbler|cup|น้ำแข็ง|เก็บความเย็น/.test(haystack)) return randomText(["🥤", "☕", "🧊"]);
  if (/โคมไฟ|lamp|light|led/.test(haystack)) return "💡";
  if (/จัดระเบียบ|บ้าน|home/.test(haystack)) return "🏠";
  if (/กีฬา|ถุงเท้า|วิ่ง|ฟิตเนส|บอล|แบด|เทนนิส|sports|running|fitness|sock/.test(haystack)) return randomText(["🏃", "⚽", "🎾"]);
  if (/รถ|car|auto|automotive/.test(haystack)) return "🚗";
  if (/ครัว|กระทะ|หม้อ|ทำอาหาร|kitchen|cook/.test(haystack)) return "🍳";
  if (/มือถือ|สมาร์ทวอทช์|หูฟัง|gadget|phone|watch|computer|usb|charger/.test(haystack)) return randomText(["📱", "💻"]);
  if (/วิตามิน|โปรตีน|เวย์|supplement|protein|health/.test(haystack)) return "💚";
  if (/สกินแคร์|เซรั่ม|ครีม|กันแดด|ผิว|beauty|skincare|serum|sunscreen/.test(haystack)) return randomText(["✨", "💖"]);
  return "✨";
}

function buildShopeeShortReviewLine(product: ShopeeProductRecord) {
  const insight = getShopeeProductInsight(product);
  const emoji = getShopeeShortReviewEmoji(product);
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""} ${product.category || ""}`).toLowerCase();
  const options = (() => {
    if (/แก้ว|ขวดน้ำ|กระติก|tumbler|cup|น้ำแข็ง|เก็บความเย็น/.test(haystack)) {
      return ["ขนาดกำลังดี พกไปทำงานหรือออกข้างนอกได้สบาย เติมเครื่องดื่มไว้จิบระหว่างวันได้ง่าย", "เติมเครื่องดื่มตอนเช้าไว้จิบระหว่างวันได้สบาย ทั้งน้ำร้อนและน้ำเย็น"];
    }
    if (/โคมไฟ|lamp|light|led/.test(haystack)) {
      return ["แสงนุ่มสบายตา ใช้อ่านหนังสือหรือทำงานตอนกลางคืนแล้วไม่แสบตา", "วางบนโต๊ะทำงานแล้วช่วยให้มุมอ่านหนังสือดูใช้งานง่ายขึ้น"];
    }
    if (/กีฬา|ถุงเท้า|วิ่ง|ฟิตเนส|บอล|แบด|เทนนิส|sports|running|fitness|sock/.test(haystack)) {
      return ["ใส่ออกกำลังกายแล้วกระชับเท้า เดินหรือวิ่งนาน ๆ ก็ยังสบาย", "เหมาะกับวันที่ต้องขยับตัวเยอะ ใส่เล่นกีฬาหรือฟิตเนสแล้วคล่องตัว"];
    }
    if (/กระเป๋า|bag|เป้|คาดอก|wallet/.test(haystack)) {
      return ["พกของจุกจิกออกจากบ้านได้เป็นระเบียบขึ้น หยิบของที่ใช้บ่อยได้ง่าย", "สะพายออกไปข้างนอกแล้วของสำคัญอยู่ใกล้ตัว ไม่ต้องค้นกระเป๋านาน"];
    }
    if (/เวย์|whey|protein|โปรตีน/.test(haystack)) {
      return ["เหมาะกับคนที่ต้องการเสริมโปรตีนในแต่ละวันหรือจัด routine หลังออกกำลังกาย", "ใช้เป็นตัวช่วยวางแผนโภชนาการสำหรับวันที่ออกกำลังกายหรือกินโปรตีนไม่พอ"];
    }
    if (/วิตามิน|supplement|vitamin/.test(haystack)) {
      return ["เหมาะกับการจัด routine ดูแลตัวเองแบบหยิบง่าย พกหรือวางไว้ประจำโต๊ะได้สะดวก", "แพ็กเก็บง่าย เหมาะกับคนที่อยากมีตัวช่วยดูแลโภชนาการไว้เป็นประจำ"];
    }
    if (/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|บำรุง|ผิว|beauty/.test(haystack)) {
      return ["หยิบใช้ใน routine ดูแลผิวได้ง่าย เนื้อและรูปแบบใช้งานดูเหมาะกับวันเร่ง ๆ", "เหมาะกับคนที่อยากมีไอเทมดูแลผิวไว้ใช้เป็นประจำโดยไม่ต้องใช้หลายขั้นตอน"];
    }
    if (/ครัว|กระทะ|หม้อ|ทำอาหาร|kitchen|cook/.test(haystack)) {
      return ["หยิบใช้ในครัวได้สะดวก ช่วยให้เตรียมอาหารหรือจัดเก็บของหลังใช้งานง่ายขึ้น", "เหมาะกับมุมครัวที่อยากให้ใช้งานคล่องขึ้นโดยไม่ต้องวางของเยอะ"];
    }
    if (!SHOPEE_HEALTH_PRODUCT_PATTERN.test(haystack) && /ขนม|snack|อาหาร(?!เสริม)|เปี๊ยะ|คุกกี้|เค้ก/.test(haystack)) {
      return ["แพ็กไว้กินเล่นหรือแบ่งกับคนที่บ้านได้ง่าย เหมาะกับช่วงอยากมีของว่างติดไว้", "ขนาดกำลังดีสำหรับเก็บไว้เป็นของว่าง หยิบกินหรือแบ่งกันได้สะดวก"];
    }
    return [compactProductText(insight.problem, 120), compactProductText(insight.situation, 120)];
  })();
  const review = compactProductText(randomText(options), 150);
  const healthSafeReview = sanitizeShopeeHealthCaptionText(review, product);
  const safeReview = containsForbiddenShopeeGenericText(healthSafeReview, product)
    ? sanitizeShopeeHealthCaptionText(compactProductText(insight.situation, 140), product)
    : healthSafeReview;
  return `${emoji} ${safeReview}`.trim();
}

function extractShopeeShortReviewLine(lines: string[], product?: ShopeeProductRecord) {
  const selected = lines
    .map((line) => normalizeTextEncoding(line).trim())
    .filter((line) => line && !/^(?:[*•\-✅]|📌|💰|🛒|📍|#)/u.test(line))
    .filter((line) => !/จุดที่ชอบ|จุดเด่น|ราคาโปร|พิกัด|รายละเอียดเพิ่มเติม/i.test(line))
    .filter((line) => !containsForbiddenShopeeGenericText(line, product))
    .map((line) => compactProductText(line, 150))
    .find((line) => line.length >= 12);
  if (!selected || !product) return selected;
  return `${getShopeeShortReviewEmoji(product)} ${selected.replace(/^[^\p{L}\p{N}]+/u, "").trim()}`.trim();
}

type ShopeeCaptionParts = {
  productName: string;
  reviewLine: string;
  priceLine?: string;
  ctaLine: string;
  shortLink: string;
  hashtags: string[];
};

function buildShopeeCaptionFromParts(parts: ShopeeCaptionParts) {
  return [
    parts.productName,
    "",
    parts.reviewLine,
    "",
    ...(parts.priceLine ? [parts.priceLine, ""] : []),
    parts.ctaLine,
    "",
    parts.shortLink,
    "",
    parts.hashtags.slice(0, SHOPEE_MAX_HASHTAGS).join(" ")
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildShopeeFallbackCaption(_product: ShopeeProductRecord, _shopeeShortUrl: string): never {
  throw new ShopeeProviderError(
    "Legacy Shopee caption generation is disabled. Product Storyboard is required.",
    422,
    "legacy_caption_disabled",
    "internal_api"
  );
}

export function sanitizeShopeeCaption(_caption: string, _shopeeShortUrl: string, _product?: ShopeeProductRecord): never {
  throw new ShopeeProviderError(
    "Legacy Shopee caption sanitizer is disabled. Product Storyboard caption validation is required.",
    422,
    "legacy_caption_disabled",
    "internal_api"
  );
}

type ShopeeProductStoryboard = {
  productSimpleName: string;
  productEntity: string;
  brand?: string;
  model?: string;
  productType: string;
  whatItIs: string;
  mainUseCase: string;
  targetUser: string;
  keySellingPoint: string;
  usageScene: string;
  captionAngle: string;
  problemSolved: string;
  dailyBenefit: string;
  emotionalBenefit: string;
  realUsageScenario: string;
  purchaseReason: string;
  primaryPainPoint: string;
};

type ShopeeStoryboardRule = {
  pattern: RegExp;
  build: (product: ShopeeProductRecord, haystack: string) => ShopeeProductStoryboard;
};

type ShopeeProductEntity = {
  rawTitle: string;
  cleanedTitle: string;
  productEntity: string;
  brand?: string;
  model?: string;
  productType: string;
  whatItIs: string;
  mainUseCase: string;
  keySellingPoint: string;
  realUsageScenario: string;
  targetUser: string;
  targetAudience?: string;
  captionAngle: string;
  confidence?: number;
  removedNoiseWords: readonly string[];
};

type ShopeeProductUnderstanding = ShopeeProductEntity & {
  targetAudience: string;
  confidence: number;
  source: "text" | "vision_rescue" | "merged";
  fallbackUsed: boolean;
  recognitionStatus: "recognized" | "fallback" | "failed";
  failureReasons: string[];
  visualEvidence?: string[];
};

type ShopeeProductTypeProfile = {
  productType: string;
  mainUseCase: string;
  targetAudience: string;
  painPoint: string;
  dailyBenefit: string;
};

const SHOPEE_PRODUCT_TYPE_LIBRARY = [
  ["scented_candle", "เพิ่มกลิ่นหอมในห้องหรือมุมพักผ่อน", "คนที่อยากให้ห้องมีกลิ่นหอม", "ห้องมีกลิ่นอับหรืออยากสร้างบรรยากาศผ่อนคลาย", "จุดหรือวางไว้ให้มุมห้องหอมและน่านั่งขึ้น"],
  ["waterproof_tablecloth", "ปูโต๊ะเพื่อกันน้ำและคราบเปื้อน", "คนที่ใช้โต๊ะกินข้าว โต๊ะทำงาน หรือโต๊ะอเนกประสงค์", "โต๊ะเปื้อนง่ายหรือเช็ดคราบยาก", "ปูโต๊ะแล้วเช็ดน้ำหรือคราบอาหารได้ง่ายขึ้น"],
  ["tablecloth", "ปูโต๊ะเพื่อแต่งโต๊ะและช่วยลดคราบเปื้อน", "คนที่อยากให้โต๊ะดูเรียบร้อยและดูแลทำความสะอาดง่าย", "โต๊ะดูโล่งหรือเลอะง่าย", "ช่วยให้โต๊ะดูเป็นระเบียบและใช้งานได้สบายขึ้น"],
  ["storage_box", "จัดเก็บของให้เป็นระเบียบ", "คนที่อยากจัดของในบ้านหรือโต๊ะทำงาน", "ของกระจัดกระจายและหาไม่เจอ", "แยกของเป็นหมวดและหยิบใช้ง่ายขึ้น"],
  ["shoe_rack", "จัดเก็บรองเท้าให้เป็นระเบียบ", "คนที่มีรองเท้าหลายคู่หรือพื้นที่หน้าบ้านจำกัด", "รองเท้าวางกองและกินพื้นที่", "วางรองเท้าเป็นชั้น ช่วยให้มุมหน้าบ้านดูเรียบร้อย"],
  ["drawer_organizer", "แบ่งช่องเก็บของในลิ้นชัก", "คนที่อยากจัดของจุกจิกให้หยิบง่าย", "ลิ้นชักรกและหาไอเทมเล็ก ๆ ยาก", "แยกของเล็ก ๆ ให้เป็นช่องชัดเจนขึ้น"],
  ["closet_organizer", "จัดเสื้อผ้าหรือของในตู้ให้เป็นระเบียบ", "คนที่อยากจัดตู้เสื้อผ้า", "ตู้แน่นและหยิบของยาก", "ช่วยแยกหมวดเสื้อผ้าและประหยัดพื้นที่"],
  ["laundry_basket", "ใส่ผ้ารอซักหรือจัดแยกผ้า", "คนที่ซักผ้าเป็นประจำ", "ผ้ากองรวมกันและแยกประเภทลำบาก", "รวบรวมผ้าให้เป็นที่ก่อนซัก"],
  ["trash_bin", "ทิ้งขยะให้เป็นที่ในบ้านหรือโต๊ะทำงาน", "คนที่อยากให้พื้นที่ใช้งานสะอาด", "ขยะชิ้นเล็ก ๆ กระจายตามโต๊ะหรือมุมห้อง", "มีที่ทิ้งขยะใกล้มือและเก็บกวาดง่ายขึ้น"],
  ["cleaning_mop", "ถูพื้นและทำความสะอาดบ้าน", "คนที่ดูแลบ้าน คอนโด หรือห้องพัก", "พื้นเปื้อนฝุ่นหรือคราบน้ำ", "ทำความสะอาดพื้นได้สะดวกขึ้น"],
  ["cleaning_brush", "ขัดล้างคราบในห้องน้ำ ครัว หรือของใช้", "คนที่ทำความสะอาดบ้านเอง", "คราบตามซอกเล็ก ๆ ล้างยาก", "ช่วยขัดซอกและคราบเฉพาะจุดได้ง่ายขึ้น"],
  ["pet_feeder", "ใส่อาหารหรือน้ำให้สัตว์เลี้ยง", "คนเลี้ยงแมว สุนัข หรือสัตว์เลี้ยงในบ้าน", "ให้อาหารน้องไม่เป็นที่หรือหกง่าย", "จัดมุมกินอาหารของสัตว์เลี้ยงให้เป็นระเบียบ"],
  ["pet_bed", "เป็นที่นอนหรือมุมพักของสัตว์เลี้ยง", "คนเลี้ยงสัตว์ที่อยากให้น้องมีมุมพัก", "สัตว์เลี้ยงไม่มีที่นอนประจำ", "ช่วยให้น้องมีมุมพักผ่อนเป็นของตัวเอง"],
  ["pet_toy", "ให้สัตว์เลี้ยงเล่นหรือออกกำลัง", "คนเลี้ยงสัตว์ที่อยากให้น้องไม่เบื่อ", "สัตว์เลี้ยงเบื่อง่ายหรืออยากหาอะไรให้เล่น", "เพิ่มกิจกรรมให้น้องเล่นระหว่างวัน"],
  ["pet_grooming_tool", "แปรงขนหรือดูแลความสะอาดสัตว์เลี้ยง", "คนเลี้ยงสัตว์ที่ดูแลขนน้องเอง", "ขนร่วงหรือพันกันง่าย", "ช่วยดูแลขนน้องให้เรียบร้อยขึ้น"],
  ["cat_litter", "ใช้รองรับขับถ่ายของแมว", "คนเลี้ยงแมว", "กลิ่นและความสะอาดของกระบะทรายจัดการยาก", "ช่วยจัดการมุมขับถ่ายของแมวให้สะอาดขึ้น"],
  ["car_phone_holder", "ยึดมือถือในรถเพื่อดูเส้นทางหรือรับสาย", "คนขับรถที่ใช้มือถือดูแผนที่", "วางมือถือในรถแล้วเลื่อนหรือหยิบยาก", "ช่วยให้ดูแผนที่ได้สะดวกและเป็นตำแหน่ง"],
  ["car_vacuum", "ดูดฝุ่นและเศษเล็ก ๆ ในรถ", "คนใช้รถที่อยากทำความสะอาดภายในรถเอง", "ฝุ่น เศษขนม หรือทรายสะสมในรถ", "ทำความสะอาดเบาะและพื้นรถได้ง่ายขึ้น"],
  ["car_charger", "ชาร์จมือถือหรืออุปกรณ์ระหว่างขับรถ", "คนใช้รถและเดินทางบ่อย", "แบตมือถือหมดระหว่างทาง", "ชาร์จอุปกรณ์ในรถได้สะดวกขึ้น"],
  ["dashcam", "ติดหน้ารถเพื่อบันทึกเส้นทางและเหตุการณ์ระหว่างขับขี่", "คนใช้รถที่อยากมีหลักฐานเวลาเดินทาง", "เกิดเหตุบนถนนแล้วไม่มีหลักฐาน", "บันทึกเหตุการณ์ขับขี่ไว้ดูย้อนหลังได้"],
  ["jump_starter", "พกไว้ช่วยสตาร์ทรถเมื่อแบตหมด", "คนใช้รถที่เดินทางหรือจอดรถนาน", "รถสตาร์ทไม่ติดตอนฉุกเฉิน", "มีตัวช่วยในรถเวลาแบตมีปัญหา"],
  ["tire", "ใช้เปลี่ยนยางรถเพื่อการขับขี่", "คนใช้รถที่ต้องเลือกยางใหม่", "ยางเดิมเสื่อมหรือไม่เหมาะกับการใช้งาน", "เลือกยางให้เข้ากับรถและการขับขี่"],
  ["phone_case", "ใส่ปกป้องมือถือและแต่งลุคเครื่อง", "คนใช้มือถือที่อยากกันรอยหรือเปลี่ยนสไตล์", "มือถือเป็นรอยหรือจับไม่ถนัด", "ช่วยกันรอยและทำให้มือถือจับถนัดขึ้น"],
  ["screen_protector", "ติดหน้าจอเพื่อช่วยกันรอย", "คนใช้มือถือหรือแท็บเล็ต", "หน้าจอเป็นรอยจากการใช้งาน", "ช่วยปกป้องหน้าจอจากรอยขีดข่วน"],
  ["charging_cable", "ใช้ชาร์จแบตหรือเชื่อมต่ออุปกรณ์", "คนใช้มือถือ แท็บเล็ต หรืออุปกรณ์อิเล็กทรอนิกส์", "สายชาร์จไม่พอหรือชาร์จไม่สะดวก", "มีสายสำรองไว้ชาร์จที่บ้าน ที่ทำงาน หรือพกไปข้างนอก"],
  ["power_bank", "ชาร์จอุปกรณ์ระหว่างเดินทาง", "คนเดินทางหรือใช้งานมือถือนอกบ้านนาน", "แบตหมดระหว่างวัน", "พกไว้สำรองแบตเวลาออกจากบ้าน"],
  ["usb_hub", "เพิ่มช่องเชื่อมต่อให้คอมพิวเตอร์หรือโน้ตบุ๊ก", "คนทำงานกับอุปกรณ์หลายชิ้น", "พอร์ตเชื่อมต่อไม่พอ", "ต่ออุปกรณ์หลายอย่างได้สะดวกขึ้น"],
  ["earbuds", "ใช้ฟังเพลง คุยสาย หรือประชุมออนไลน์", "คนใช้มือถือ ฟังเพลง หรือทำงานออนไลน์", "ต้องการฟังเสียงส่วนตัวระหว่างวัน", "พกฟังเสียงหรือคุยสายได้สะดวก"],
  ["speaker", "เปิดเพลงหรือเสียงในห้องหรือระหว่างกิจกรรม", "คนที่อยากฟังเพลงร่วมกันหรือเพิ่มเสียงให้พื้นที่", "เสียงมือถือไม่พอหรือฟังร่วมกันยาก", "เปิดเสียงให้มุมพักผ่อนหรือกิจกรรมสนุกขึ้น"],
  ["smartwatch", "ใส่ดูเวลา การแจ้งเตือน หรือข้อมูลกิจกรรม", "คนที่อยากมีแกดเจ็ตติดข้อมือ", "หยิบมือถือบ่อยหรืออยากดูข้อมูลเร็วขึ้น", "ดูข้อมูลบนข้อมือได้สะดวกระหว่างวัน"],
  ["tripod", "ตั้งกล้องหรือมือถือเพื่อถ่ายภาพและวิดีโอ", "คนทำคอนเทนต์หรือถ่ายภาพเอง", "ถ่ายเองแล้วมุมไม่นิ่ง", "ช่วยตั้งมุมถ่ายให้มั่นคงขึ้น"],
  ["action_camera", "ถ่ายกิจกรรม เดินทาง หรือคอนเทนต์มุมกว้าง", "คนทำคอนเทนต์หรือชอบเดินทาง", "อยากเก็บภาพมุมแอคชั่นหรือมุมกว้าง", "พกถ่ายกิจกรรมได้คล่องตัวขึ้น"],
  ["kitchen_container", "เก็บอาหาร วัตถุดิบ หรือของแห้ง", "คนทำอาหารหรือจัดครัว", "วัตถุดิบเปิดถุงแล้วเก็บยาก", "เก็บของในครัวให้เป็นหมวดและหยิบง่าย"],
  ["ice_tray", "ทำน้ำแข็งและแยกก้อนออกมาใช้", "คนที่ทำเครื่องดื่มหรือใช้ตู้เย็นที่บ้าน", "น้ำแข็งหมดหรือแกะออกยาก", "เตรียมน้ำแข็งไว้ใช้กับเครื่องดื่มได้ง่าย"],
  ["lunch_box", "ใส่อาหารเพื่อพกไปทำงาน โรงเรียน หรือเดินทาง", "คนที่เตรียมอาหารเอง", "พกอาหารแล้วหกหรือแยกช่องยาก", "พกมื้ออาหารให้เป็นระเบียบขึ้น"],
  ["pan", "ใช้ผัด ทอด หรือทำอาหารในครัว", "คนทำอาหารที่บ้าน", "อุปกรณ์ครัวไม่พอกับเมนูที่ทำ", "ช่วยเตรียมอาหารประจำวันได้สะดวกขึ้น"],
  ["pot", "ใช้ต้ม แกง หรือทำอาหารในครัว", "คนทำอาหารที่บ้าน", "ต้องการหม้อสำหรับเมนูต้มและแกง", "ทำอาหารเมนูน้ำได้ง่ายขึ้น"],
  ["knife", "ใช้หั่น สับ หรือเตรียมวัตถุดิบ", "คนทำอาหารที่บ้าน", "เตรียมวัตถุดิบช้าเพราะอุปกรณ์ไม่ถนัด", "หั่นวัตถุดิบได้คล่องขึ้น"],
  ["cutting_board", "รองหั่นวัตถุดิบในครัว", "คนทำอาหารที่บ้าน", "หั่นของแล้วเลอะโต๊ะหรือไม่ถูกสุขลักษณะ", "เตรียมวัตถุดิบได้เป็นที่มากขึ้น"],
  ["water_filter", "กรองหรือกดน้ำดื่มสะอาดไว้ใช้ในบ้าน", "คนอยู่บ้าน คอนโด หรือครอบครัว", "ต้องซื้อน้ำขวดบ่อยหรืออยากมีน้ำดื่มพร้อมใช้", "มีน้ำดื่มพร้อมกดใช้ในบ้าน"],
  ["water_purifier", "กดน้ำดื่มสะอาดไว้ใช้ในบ้าน", "คนอยู่บ้านหรือคอนโด", "อยากมีน้ำดื่มสะอาดพร้อมใช้", "กดน้ำดื่มระหว่างวันได้สะดวก"],
  ["water_purifier_accessory", "ใช้เปลี่ยนหรือใช้งานร่วมกับเครื่องกรองน้ำเพื่อกรองน้ำดื่ม", "ผู้ใช้เครื่องกรองน้ำ", "ไส้กรองหรืออะไหล่ต้องเปลี่ยนตามรอบ", "ช่วยให้เครื่องกรองน้ำพร้อมใช้งานต่อเนื่อง"],
  ["travel_bottle", "ใส่ของเหลวหรือสกินแคร์ขนาดพกพา", "คนเดินทางหรือพกของใช้ส่วนตัว", "พกขวดใหญ่แล้วกินพื้นที่", "แบ่งของใช้ลงขวดเล็กเพื่อพกง่ายขึ้น"],
  ["thermal_cup", "ใส่เครื่องดื่มและช่วยเก็บอุณหภูมิ", "คนทำงาน เดินทาง หรือชอบพกเครื่องดื่ม", "เครื่องดื่มหายเย็นหรือหายร้อนเร็ว", "มีเครื่องดื่มไว้จิบระหว่างวันได้สะดวก"],
  ["drinkware", "ใส่เครื่องดื่มและพกพาระหว่างวัน", "คนทำงาน คนเดินทาง หรือคนออกกำลังกาย", "ไม่มีภาชนะพกเครื่องดื่มที่ใช้ง่าย", "พกน้ำหรือเครื่องดื่มไปข้างนอกได้ง่าย"],
  ["water_bottle", "ใส่น้ำดื่มและพกพาระหว่างวัน", "คนที่อยากพกน้ำติดตัว", "ดื่มน้ำน้อยหรือไม่มีขวดพกสะดวก", "มีน้ำไว้จิบระหว่างทำงานหรือเดินทาง"],
  ["mug", "ใส่เครื่องดื่มร้อนหรือเย็นบนโต๊ะทำงาน", "คนทำงานหรือคนที่ชอบดื่มกาแฟ ชา", "อยากมีแก้วประจำโต๊ะ", "วางเครื่องดื่มไว้จิบระหว่างวัน"],
  ["sport_shirt", "สวมใส่ออกกำลังกายหรือทำกิจกรรมกลางแจ้ง", "คนออกกำลังกายหรือชอบลุคสปอร์ต", "เสื้อทั่วไปเคลื่อนไหวไม่คล่อง", "ใส่เล่นกีฬา เดินทาง หรือวันลำลองได้"],
  ["shirt", "สวมใส่และแมตช์กับลุคตามโอกาส", "คนที่หาเสื้อใส่ง่าย", "ไม่รู้จะหยิบเสื้อตัวไหนให้เข้ากับวัน", "แมตช์กับกางเกงหรือกระโปรงได้ง่าย"],
  ["apparel", "สวมใส่ในชีวิตประจำวันหรือแต่งตัวตามโอกาส", "คนที่หาเสื้อผ้าใส่ง่าย", "แต่งตัวให้เข้ากับโอกาสไม่ลงตัว", "เลือกใส่ทำงาน ไปเที่ยว หรือวันลำลองได้"],
  ["dress", "สวมใส่แต่งตัวไปทำงาน ไปเที่ยว หรือโอกาสพิเศษ", "คนที่ชอบชุดใส่ง่ายครบลุค", "อยากแต่งตัวให้จบในชิ้นเดียว", "ใส่แล้วได้ลุคพร้อมออกจากบ้าน"],
  ["skirt", "สวมใส่และแมตช์กับเสื้อผ้าตามโอกาส", "คนที่ชอบแต่งตัวหลายลุค", "อยากได้ชิ้นที่แมตช์กับเสื้อได้หลายแบบ", "ใส่คู่กับเสื้อทำงานหรือวันเที่ยวได้"],
  ["pants", "สวมใส่และแต่งตัวให้เข้ากับกิจกรรมระหว่างวัน", "คนที่ต้องการกางเกงใส่ง่าย", "กางเกงไม่เข้ากับกิจกรรมหรือเคลื่อนไหวไม่สะดวก", "ใส่ทำงาน เดินทาง หรือทำกิจกรรมได้คล่องขึ้น"],
  ["shorts", "สวมใส่ลำลอง เล่นกีฬา หรือพักผ่อน", "คนที่อยากได้กางเกงใส่สบาย", "ใส่ขายาวแล้วร้อนหรือเคลื่อนไหวไม่สะดวก", "ใส่วันสบาย ๆ หรือออกกำลังกายได้ง่าย"],
  ["running_shoes", "สวมใส่วิ่ง เดิน หรือทำกิจกรรมที่ต้องเคลื่อนไหว", "คนวิ่ง ออกกำลังกาย หรือเดินเยอะ", "รองเท้าไม่เข้ากับการเคลื่อนไหว", "ช่วยให้เดินหรือวิ่งได้คล่องขึ้น"],
  ["sport_shoes", "สวมใส่ออกกำลังกายหรือทำกิจกรรมที่ต้องเคลื่อนไหว", "คนออกกำลังกายหรือเล่นกีฬา", "รองเท้าไม่เหมาะกับกิจกรรม", "ใส่ขยับตัวและออกกำลังกายได้มั่นใจขึ้น"],
  ["sandals", "สวมใส่เดินลำลองหรือใช้งานในวันสบาย ๆ", "คนที่อยากได้รองเท้าใส่ง่าย", "ใส่รองเท้าหุ้มส้นแล้วร้อนหรือไม่สะดวก", "หยิบใส่ออกไปทำธุระหรือเดินเล่นได้ง่าย"],
  ["socks", "สวมใส่กับรองเท้าเพื่อลดการเสียดสี", "คนที่ใส่รองเท้าหรือเล่นกีฬา", "เท้าเสียดสีกับรองเท้าหรือไม่กระชับ", "ใส่รองเท้าได้สบายและกระชับขึ้น"],
  ["travel_pillow", "รองคอระหว่างเดินทาง", "นักเดินทางหรือคนที่นั่งรถและเครื่องบินนาน", "เดินทางนานแล้วปวดคอหรือหลับไม่สบาย", "ช่วยรองรับต้นคอระหว่างเดินทาง"],
  ["necklace", "สวมใส่เป็นเครื่องประดับและแมตช์ลุค", "คนที่ชอบเครื่องประดับ", "ลุคเรียบเกินไปและอยากเพิ่มดีเทล", "เติมดีเทลช่วงคอให้ลุคดูครบขึ้น"],
  ["earring", "สวมใส่เป็นเครื่องประดับบนใบหู", "คนที่ชอบต่างหูหรือแต่งลุค", "อยากให้ใบหน้าหรือลุคดูมีดีเทล", "ใส่เพิ่มจุดเด่นให้ลุคประจำวัน"],
  ["bracelet", "สวมใส่เป็นเครื่องประดับข้อมือ", "คนที่ชอบเครื่องประดับข้อมือ", "ข้อมือดูโล่งหรืออยากเพิ่มดีเทลเล็ก ๆ", "แมตช์กับนาฬิกาหรือชุดประจำวันได้"],
  ["ring", "สวมใส่เป็นเครื่องประดับนิ้วมือ", "คนที่ชอบแหวนหรือเครื่องประดับเล็ก", "อยากเพิ่มดีเทลให้มือและลุค", "ใส่เพิ่มความเรียบร้อยให้การแต่งตัว"],
  ["jewelry", "สวมใส่เป็นเครื่องประดับและแมตช์ลุค", "คนที่ชอบเครื่องประดับ", "แต่งตัวแล้วลุคยังขาดดีเทล", "ช่วยให้ลุคดูมีอะไรขึ้นโดยไม่ต้องแต่งเยอะ"],
  ["wallet", "ใส่เงิน บัตร และของชิ้นเล็ก", "คนที่พกเงินสดหรือบัตรหลายใบ", "บัตรและเงินกระจัดกระจายในกระเป๋า", "จัดของสำคัญให้หยิบใช้ง่ายขึ้น"],
  ["backpack", "ใส่ของและพกพาระหว่างเรียน ทำงาน หรือเดินทาง", "คนที่พกของเยอะหรือเดินทาง", "ของเยอะและถือไม่สะดวก", "สะพายของจำเป็นได้เป็นระเบียบ"],
  ["handbag", "ใส่ของส่วนตัวและแมตช์กับลุค", "คนที่อยากมีกระเป๋าใช้ประจำวัน", "พกของจุกจิกแล้วลุคไม่ลงตัว", "ถือหรือสะพายออกจากบ้านได้พร้อมลุค"],
  ["crossbody_bag", "ใส่ของจำเป็นและสะพายติดตัวระหว่างวัน", "คนเดินทางหรือออกไปข้างนอกบ่อย", "หยิบของสำคัญในกระเป๋าใหญ่ยาก", "เก็บมือถือ กระเป๋าสตางค์ และของจำเป็นใกล้ตัว"],
  ["tote_bag", "ใส่ของใช้ประจำวันและพกพาออกจากบ้าน", "คนที่ชอบกระเป๋าใส่ง่ายและจุของ", "ของใช้หลายชิ้นไม่มีที่รวม", "ใส่ของจำเป็นไปทำงานหรือคาเฟ่ได้ง่าย"],
  ["bag", "ใช้ใส่ของและพกพาระหว่างวัน", "คนที่เดินทางหรือพกของออกจากบ้านบ่อย", "ของจุกจิกกระจัดกระจาย", "รวมของจำเป็นไว้หยิบง่ายขึ้น"],
  ["skincare", "ใช้บำรุงและดูแลผิว", "คนที่มองหาไอเทมดูแลผิว", "ผิวดูแห้งหรืออยากเพิ่มขั้นตอนดูแลผิว", "ใช้หลังล้างหน้าหรือก่อนแต่งหน้าได้"],
  ["sunscreen", "ทาก่อนออกแดดหรือก่อนแต่งหน้าเพื่อช่วยดูแลผิว", "คนที่ต้องออกแดดหรืออยู่ห้องแอร์", "แดดและสภาพแวดล้อมทำให้ผิวดูเหนื่อยล้า", "ทาช่วงเช้าก่อนออกจากบ้านได้"],
  ["serum", "ทาบำรุงผิวหลังล้างหน้า", "คนที่อยากเพิ่มขั้นตอนบำรุงผิว", "ผิวดูแห้งหรือไม่สดใส", "เติมสกินแคร์บางเบาก่อนลงครีมหรือแต่งหน้า"],
  ["moisturizer", "ทาเพื่อเติมความชุ่มชื้นให้ผิว", "คนที่ผิวแห้งหรืออยู่ห้องแอร์บ่อย", "ผิวแห้งตึงระหว่างวัน", "ช่วยให้ผิวรู้สึกชุ่มชื้นขึ้น"],
  ["cleanser", "ใช้ล้างหน้าและทำความสะอาดผิว", "คนที่ล้างหน้าทุกวันหรือแต่งหน้า", "ผิวหน้ามีคราบกันแดดหรือความมัน", "ล้างหน้าให้พร้อมลงสกินแคร์ขั้นต่อไป"],
  ["makeup_brush", "ใช้แต่งหน้าและเกลี่ยเครื่องสำอาง", "คนแต่งหน้าหรือเริ่มฝึกแต่งหน้า", "แต่งหน้าแล้วเกลี่ยไม่เนียน", "ช่วยลงเมคอัพได้เป็นจังหวะมากขึ้น"],
  ["makeup_sponge", "ใช้เกลี่ยรองพื้นหรือคอนซีลเลอร์", "คนแต่งหน้าที่อยากให้งานผิวดูเนียน", "รองพื้นเป็นคราบหรือเกลี่ยยาก", "เกลี่ยงานผิวให้ดูเรียบขึ้น"],
  ["hair_dryer", "ใช้เป่าผมหลังสระหรือจัดทรงเบื้องต้น", "คนที่สระผมบ่อยหรือรีบออกจากบ้าน", "ผมแห้งช้าและจัดทรงยาก", "ช่วยให้ผมแห้งไวขึ้นก่อนออกจากบ้าน"],
  ["hair_styler", "ใช้จัดแต่งทรงผมหรือม้วนผม", "คนที่จัดทรงผมเอง", "ผมไม่เป็นทรงในวันที่ต้องออกไปข้างนอก", "ช่วยจัดทรงให้พร้อมก่อนออกจากบ้าน"],
  ["beauty_tool", "ใช้แต่งหน้า ดูแลผิว หรือดูแลความงาม", "คนที่ดูแลผิวหรือแต่งหน้าเอง", "ขั้นตอนความงามทำได้ไม่ถนัด", "ช่วยให้ดูแลตัวเองได้เป็นระบบขึ้น"],
  ["lipstick", "ใช้แต่งริมฝีปากและเติมสีให้ลุค", "คนแต่งหน้าหรืออยากเติมสีปาก", "ลุคดูซีดหรืออยากเติมความสดใส", "ทาเติมระหว่างวันให้หน้าดูมีสีสัน"],
  ["perfume", "ใช้เพิ่มกลิ่นหอมให้ร่างกาย", "คนที่อยากมีกลิ่นหอมติดตัว", "อยากเพิ่มความมั่นใจก่อนออกจากบ้าน", "ฉีดก่อนออกไปทำงานหรือพบคน"],
  ["snack", "ใช้รับประทานเป็นของทานเล่น", "คนที่อยากมีของว่างติดบ้าน", "อยากกินของว่างหรือแบ่งกินระหว่างวัน", "เก็บไว้กินเล่นหรือแบ่งกับคนที่บ้าน"],
  ["instant_food", "ใช้รับประทานหรือเตรียมมื้ออาหารแบบสะดวก", "คนที่อยากมีอาหารเตรียมง่าย", "ไม่มีเวลาเตรียมอาหารนาน", "มีมื้อสะดวกไว้กินตอนรีบ"],
  ["beverage", "ใช้ดื่มหรือชงเป็นเครื่องดื่ม", "คนที่ชอบเครื่องดื่มหรืออยากมีไว้ติดบ้าน", "อยากมีเครื่องดื่มพร้อมชงหรือพร้อมดื่ม", "เก็บไว้ดื่มระหว่างวันได้"],
  ["food", "ใช้รับประทานเป็นอาหารหรือของทานเล่น", "คนที่อยากมีของกินติดบ้าน", "อยากมีของกินที่หยิบง่าย", "เก็บไว้กินกับมื้ออาหารหรือเป็นของว่าง"],
  ["supplement", "ใช้เสริมการดูแลสุขภาพตามคำแนะนำบนสินค้า", "คนที่ดูแลสุขภาพหรือโภชนาการ", "อยากจัด routine ดูแลตัวเองให้เป็นระบบ", "หยิบทานตามคำแนะนำบนฉลากได้"],
  ["protein_powder", "ใช้เสริมโปรตีนในวันที่ออกกำลังกายหรือจัดโภชนาการ", "คนออกกำลังกายหรือคุมโปรตีน", "โปรตีนในมื้ออาหารไม่พอ", "ชงเสริมโปรตีนหลังออกกำลังกายได้"],
  ["vitamin", "ใช้เสริมวิตามินตามคำแนะนำบนสินค้า", "คนที่ดูแลสุขภาพหรือเลือกวิตามินประจำวัน", "อยากเติมสารอาหารบางอย่างให้ routine", "หยิบทานตามรอบที่ระบุบนสินค้า"],
  ["health_supplement", "ใช้เสริมการดูแลสุขภาพหรือโภชนาการตามคำแนะนำบนสินค้า", "คนที่ดูแลสุขภาพ", "อยากมีตัวช่วยดูแลโภชนาการ", "จัด routine ดูแลสุขภาพได้ง่ายขึ้น"],
  ["badminton_shuttlecock", "ใช้ซ้อมตีแบดหรือเล่นแบดมินตัน", "คนเล่นแบดมินตัน", "ลูกแบดไม่พอสำหรับซ้อมหรือเล่น", "หยิบใช้ซ้อมหรือเล่นกับเพื่อนได้"],
  ["yoga_mat", "ใช้รองออกกำลังกาย โยคะ หรือยืดกล้ามเนื้อ", "คนออกกำลังกายที่บ้านหรือฟิตเนส", "พื้นแข็งหรือลื่นเวลาออกกำลังกาย", "ปูรองพื้นให้เคลื่อนไหวได้มั่นคงขึ้น"],
  ["fitness_equipment", "ใช้ฝึกกล้ามเนื้อหรือออกกำลังกาย", "คนออกกำลังกายที่บ้านหรือฟิตเนส", "อยากเพิ่มอุปกรณ์ให้การซ้อม", "ช่วยให้ซ้อมได้หลากหลายขึ้น"],
  ["sports_equipment", "ใช้เล่นกีฬา ฝึกซ้อม หรือออกกำลังกาย", "คนเล่นกีฬาและออกกำลังกาย", "อุปกรณ์ไม่พร้อมสำหรับกิจกรรม", "ช่วยให้เล่นหรือซ้อมได้สะดวกขึ้น"],
  ["desk_lamp", "เพิ่มแสงสว่างตอนอ่านหนังสือ ทำงาน หรือใช้คอม", "คนทำงาน อ่านหนังสือ หรือจัดโต๊ะ", "แสงไม่พอหรือมุมโต๊ะมืด", "ช่วยให้โต๊ะทำงานสว่างและใช้งานง่ายขึ้น"],
  ["office_chair", "ใช้รองรับการนั่งทำงาน อ่านหนังสือ หรือใช้งานคอมพิวเตอร์", "คนทำงานหน้าคอมหรือจัดมุมทำงาน", "นั่งทำงานนานแล้วไม่สบาย", "ช่วยให้มุมทำงานนั่งใช้งานได้นานขึ้น"],
  ["desk_accessory", "จัดโต๊ะทำงานหรือช่วยให้ใช้งานสะดวก", "คนทำงานหรือเรียนที่โต๊ะ", "โต๊ะรกหรือหยิบของยาก", "ช่วยให้โต๊ะเป็นระเบียบและทำงานคล่องขึ้น"],
  ["fan", "ช่วยเพิ่มลมและระบายอากาศ", "คนที่อยู่ห้องร้อนหรือทำงานที่โต๊ะ", "อากาศร้อนหรืออับระหว่างวัน", "เปิดใช้ให้รู้สึกสบายขึ้นในพื้นที่ส่วนตัว"],
  ["humidifier", "เพิ่มความชื้นในห้องหรือมุมพักผ่อน", "คนอยู่ห้องแอร์หรือห้องแห้ง", "อากาศแห้งจนรู้สึกไม่สบาย", "ช่วยให้มุมห้องรู้สึกสบายขึ้น"],
  ["home_fragrance", "เพิ่มกลิ่นหอมในห้องหรือมุมใช้งาน", "คนที่อยากปรับบรรยากาศห้อง", "ห้องมีกลิ่นอับหรืออยากให้มุมพักผ่อนหอมขึ้น", "ทำให้ห้องมีกลิ่นหอมและน่าอยู่ขึ้น"],
  ["decorative_light", "ตกแต่งและเพิ่มบรรยากาศให้มุมห้อง", "คนที่แต่งห้องหรือจัดมุมถ่ายรูป", "มุมห้องดูเรียบหรือแสงไม่พอ", "ช่วยให้มุมห้องดูมีบรรยากาศขึ้น"],
  ["wall_hook", "แขวนของให้เป็นที่", "คนที่อยากจัดของโดยไม่กินพื้นที่", "ของใช้แขวนไม่เป็นที่และหาไม่เจอ", "แขวนของที่ใช้บ่อยให้หยิบง่ายขึ้น"],
  ["bathroom_accessory", "จัดของหรือใช้งานในห้องน้ำ", "คนที่ดูแลห้องน้ำหรือจัดของใช้ส่วนตัว", "ของในห้องน้ำวางไม่เป็นที่", "ช่วยให้มุมห้องน้ำเรียบร้อยและหยิบง่าย"],
  ["pillow", "รองศีรษะหรือใช้พักผ่อน", "คนที่ต้องการหมอนสำหรับนอนหรือพัก", "นอนพักแล้วรองรับไม่สบาย", "ช่วยให้มุมพักผ่อนสบายขึ้น"],
  ["bedding", "ใช้กับเตียงเพื่อการนอนหรือพักผ่อน", "คนที่จัดห้องนอนหรือเปลี่ยนชุดเครื่องนอน", "เครื่องนอนเก่าหรือไม่เข้ากับห้อง", "ทำให้เตียงพร้อมใช้งานและดูเรียบร้อย"],
  ["blanket", "ใช้ห่มเพื่อเพิ่มความอบอุ่นหรือความสบาย", "คนที่นอนห้องแอร์หรือพักผ่อนบนโซฟา", "รู้สึกหนาวหรืออยากมีผ้าห่มใกล้ตัว", "หยิบห่มตอนพักผ่อนได้ง่าย"],
  ["curtain", "ใช้บังแสง เพิ่มความเป็นส่วนตัว หรือแต่งห้อง", "คนที่จัดห้องนอนหรือห้องนั่งเล่น", "แสงเข้าห้องมากหรืออยากเพิ่มความเป็นส่วนตัว", "ช่วยคุมแสงและทำให้ห้องดูเรียบร้อยขึ้น"],
  ["rug", "ปูพื้นเพื่อกันลื่น ตกแต่ง หรือเพิ่มความสบาย", "คนที่แต่งห้องหรือจัดมุมใช้งาน", "พื้นโล่ง ลื่น หรืออยากให้มุมห้องดูอุ่นขึ้น", "ช่วยให้มุมพื้นใช้งานสบายและดูมีสไตล์ขึ้น"],
  ["umbrella", "ใช้กันฝนหรือกันแดดระหว่างเดินทาง", "คนที่เดินทางและต้องเจอฝนหรือแดด", "ฝนตกหรือแดดแรงตอนออกจากบ้าน", "พกไว้ใช้เวลาฝนตกหรือแดดจัด"],
  ["raincoat", "สวมใส่กันฝนระหว่างเดินทาง", "คนที่เดินทางด้วยมอเตอร์ไซค์หรือเดินกลางแจ้ง", "ฝนตกแล้วเสื้อผ้าเปียก", "ช่วยกันฝนระหว่างทางได้"],
  ["travel_bag", "ใส่ของสำหรับเดินทางหรือทริปสั้น", "คนเดินทางหรือจัดกระเป๋าไปทริป", "ของเดินทางเยอะและจัดยาก", "ช่วยรวมของจำเป็นสำหรับทริปให้เป็นที่"],
  ["luggage", "ใส่เสื้อผ้าและของใช้สำหรับเดินทาง", "คนเดินทางต่างจังหวัดหรือต่างประเทศ", "จัดของเดินทางไม่เป็นระเบียบ", "ช่วยแพ็กของเดินทางได้ง่ายขึ้น"],
  ["camera_bag", "ใส่กล้องและอุปกรณ์ถ่ายภาพ", "คนถ่ายรูปหรือทำคอนเทนต์", "อุปกรณ์กล้องกระจัดกระจายและเสี่ยงกระแทก", "พกกล้องและอุปกรณ์ได้เป็นสัดส่วน"],
  ["baby_bottle", "ใส่นมหรือน้ำให้เด็กเล็ก", "พ่อแม่หรือผู้ดูแลเด็ก", "เตรียมนมให้เด็กระหว่างวันไม่สะดวก", "ช่วยเตรียมขวดนมไว้ใช้งานได้ง่าย"],
  ["baby_toy", "ให้เด็กเล่นหรือฝึกพัฒนาการตามวัย", "พ่อแม่หรือผู้ดูแลเด็ก", "อยากหาไอเทมให้เด็กเล่นอย่างเหมาะสม", "เพิ่มกิจกรรมเล่นระหว่างวัน"],
  ["stationery", "ใช้จด เขียน วาด หรือจัดงานเอกสาร", "นักเรียน นักศึกษา หรือคนทำงาน", "อุปกรณ์เขียนไม่พร้อมเวลาต้องใช้งาน", "ช่วยให้จดงานหรือจัดเอกสารได้สะดวกขึ้น"],
  ["notebook", "ใช้จดบันทึก วางแผน หรือเรียน", "นักเรียน นักศึกษา หรือคนทำงาน", "ไอเดียหรืองานกระจัดกระจาย", "จดสิ่งที่ต้องทำและวางแผนได้เป็นที่"],
  ["pen", "ใช้เขียน จด หรือเซ็นเอกสาร", "นักเรียน นักศึกษา หรือคนทำงาน", "ไม่มีปากกาที่เขียนถนัด", "หยิบจดงานหรือเซ็นเอกสารได้ทันที"],
  ["art_supply", "ใช้วาด ระบายสี หรือทำงานศิลปะ", "คนวาดรูป นักเรียน หรือสายงานคราฟต์", "อุปกรณ์ศิลปะไม่ครบสำหรับชิ้นงาน", "ช่วยสร้างงานวาดหรืองานคราฟต์ได้สะดวกขึ้น"],
  ["toy", "ใช้เล่นหรือสะสมเพื่อความเพลิดเพลิน", "เด็ก คนสะสม หรือคนที่ซื้อเป็นของขวัญ", "อยากหาไอเทมเล่นหรือของขวัญ", "เพิ่มความสนุกหรือเติมมุมสะสม"],
  ["collectible", "สะสม ตั้งโชว์ หรือใช้ตกแต่งมุมโปรด", "สายสะสมหรือคนชอบของตกแต่ง", "มุมโชว์ยังขาดคาแรกเตอร์", "วางตั้งโชว์ให้มุมโต๊ะหรือชั้นดูมีเรื่องราว"],
  ["book", "ใช้อ่านเพื่อความรู้ ความบันเทิง หรือพัฒนาตัวเอง", "คนอ่านหนังสือ นักเรียน หรือคนทำงาน", "อยากมีเนื้อหาอ่านเพิ่มตามความสนใจ", "หยิบอ่านในเวลาว่างหรือใช้ประกอบการเรียนรู้"],
  ["plant_pot", "ใช้ปลูกต้นไม้หรือแต่งมุมสวน", "คนปลูกต้นไม้หรือแต่งบ้าน", "ต้นไม้ไม่มีภาชนะที่เหมาะกับมุมวาง", "จัดต้นไม้ให้เป็นระเบียบและดูดีขึ้น"],
  ["gardening_tool", "ใช้ดูแลต้นไม้หรือสวน", "คนปลูกต้นไม้หรือทำสวน", "ดูแลต้นไม้ไม่ถนัดเพราะอุปกรณ์ไม่พร้อม", "ช่วยรดน้ำ ตัดแต่ง หรือจัดสวนได้ง่ายขึ้น"],
  ["home_storage", "จัดเก็บของให้เป็นระเบียบ", "คนที่อยากจัดบ้านหรือห้องให้เรียบร้อย", "ของในบ้านรกหรือวางปนกัน", "ช่วยให้มุมใช้งานดูเป็นระเบียบขึ้น"],
  ["kitchenware", "ใช้เตรียมอาหารหรือใช้งานในครัว", "คนทำอาหารหรือจัดครัว", "ครัวใช้งานไม่คล่องหรืออุปกรณ์ไม่พร้อม", "ช่วยให้เตรียมอาหารและจัดครัวง่ายขึ้น"],
  ["pet_supply", "ใช้ดูแลสัตว์เลี้ยง", "คนเลี้ยงสัตว์", "การดูแลสัตว์เลี้ยงยังไม่สะดวก", "ช่วยให้มุมของสัตว์เลี้ยงเป็นระบบขึ้น"],
  ["automotive_accessory", "ใช้กับรถยนต์หรือพกไว้ในรถ", "คนใช้รถ", "อยากเพิ่มความสะดวกหรือความพร้อมในรถ", "ช่วยให้การใช้รถประจำวันสะดวกขึ้น"],
  ["electronics_accessory", "ใช้ร่วมกับอุปกรณ์อิเล็กทรอนิกส์", "คนใช้มือถือ คอมพิวเตอร์ หรือแกดเจ็ต", "ใช้อุปกรณ์แล้วขาดตัวเชื่อมต่อหรือของเสริม", "ช่วยให้ใช้อุปกรณ์อิเล็กทรอนิกส์ได้คล่องขึ้น"],
  ["beauty_tool", "ใช้แต่งหน้า ดูแลผิว หรือดูแลความงาม", "คนดูแลผิวหรือแต่งหน้า", "ขั้นตอนความงามยังไม่ถนัด", "ช่วยให้แต่งหน้าหรือดูแลผิวง่ายขึ้น"],
  ["shoes", "สวมใส่เดินหรือทำกิจกรรมต่าง ๆ", "คนที่ต้องเดินหรือแต่งตัวตามกิจกรรม", "รองเท้าไม่เข้ากับกิจกรรม", "ใส่เดินหรือทำกิจกรรมได้สะดวกขึ้น"]
].map(([productType, mainUseCase, targetAudience, painPoint, dailyBenefit]) => ({
  productType,
  mainUseCase,
  targetAudience,
  painPoint,
  dailyBenefit
})) satisfies ShopeeProductTypeProfile[];

const SHOPEE_KNOWN_PRODUCT_TYPES = SHOPEE_PRODUCT_TYPE_LIBRARY.map((item) => item.productType);
const SHOPEE_PRODUCT_TYPE_PROFILE_BY_TYPE = Object.fromEntries(
  SHOPEE_PRODUCT_TYPE_LIBRARY.map((item) => [item.productType, item])
) as Record<string, ShopeeProductTypeProfile>;
const SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE = Object.fromEntries(
  SHOPEE_PRODUCT_TYPE_LIBRARY.map((item) => [item.productType, item.mainUseCase])
) as Record<string, string>;
const shopeeProductUnderstandingCoverageStats = new Map<string, {
  entityCount: number;
  successCount: number;
  failureCount: number;
  missingMainUseCaseCount: number;
}>();

let shopeeProductUnderstandingCoverageLogged = false;

function normalizeShopeeProductTypeKey(value?: string) {
  return normalizeTextEncoding(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function getShopeeMappedMainUseCase(productType?: string, productEntity?: string) {
  const rawType = normalizeTextEncoding(productType ?? "").trim();
  const typeKey = normalizeShopeeProductTypeKey(rawType);
  if (SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE[typeKey]) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE[typeKey];

  const haystack = `${rawType} ${productEntity ?? ""}`;
  if (/sport_shirt|เสื้อกีฬา|sport\s?shirt/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.sport_shirt;
  if (/เสื้อ|กระโปรง|เดรส|กางเกง|เสื้อผ้า|แฟชั่น|shirt|skirt|dress|pants|apparel/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.apparel;
  if (/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|ผิว/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.skincare;
  if (/กระบอกน้ำ|ขวดน้ำ|กระติก|แก้วเก็บ|tumbler|drinkware|water\s?bottle/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.drinkware;
  if (/หมอนรองคอ|travel_pillow|neck\s?pillow/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.travel_pillow;
  if (/จัดเก็บ|กล่องเก็บ|ชั้นวาง|storage|organizer/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.home_storage;
  if (/ครัว|ถาดน้ำแข็ง|หม้อ|กระทะ|kitchen|kitchenware/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.kitchenware;
  if (/สัตว์เลี้ยง|pet|cat|dog/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.pet_supply;
  if (/รถ|automotive|dashcam|กล้องติดรถ|ยาง|จัมป์|แบต/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.automotive_accessory;
  if (/มือถือ|หูฟัง|แกดเจ็ต|gadget|electronics|สมาร์ทวอทช์|charger|usb/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.electronics_accessory;
  if (/แต่งหน้า|makeup|beauty_tool|แปรงแต่งหน้า|พัฟ|ฟองน้ำ/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.beauty_tool;
  if (/สร้อย|เครื่องประดับ|จี้|ต่างหู|แหวน|กำไล|jewelry|necklace/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.jewelry;
  if (/กระเป๋า|bag|เป้|wallet|crossbody/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.bag;
  if (/รองเท้า|shoe|sneaker|running_shoes|sport_shoes/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.shoes;
  if (/อาหาร|ขนม|snack|food|เครื่องดื่ม|น้ำพริก/i.test(haystack) && !/อาหารเสริม|วิตามิน|โปรตีน|เวย์/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.food;
  if (/อาหารเสริม|วิตามิน|โปรตีน|เวย์|supplement|vitamin|protein|whey/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.health_supplement;
  if (/กีฬา|แบด|ลูกแบด|fitness|sport|exercise/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.sports_equipment;
  if (/art toy|อาร์ตทอย|ของสะสม|ฟิกเกอร์|collectible|กล่องสุ่ม/i.test(haystack)) return SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE.collectible;
  const profile = getShopeeProductTypeProfile(rawType, productEntity);
  if (profile) return profile.mainUseCase;
  return "";
}

function getShopeeProductTypeProfile(productType?: string, productEntity?: string) {
  const rawType = normalizeTextEncoding(productType ?? "").trim();
  const typeKey = normalizeShopeeProductTypeKey(rawType);
  const directProfile = SHOPEE_PRODUCT_TYPE_PROFILE_BY_TYPE[typeKey];
  if (directProfile) return directProfile;

  const haystack = `${rawType} ${productEntity ?? ""}`;
  const profileRules: Array<[RegExp, string]> = [
    [/เทียนหอม|scented\s?candle|aroma\s?candle|soy\s?wax|apple\s*cranberry/i, "scented_candle"],
    [/ผ้าปูโต๊ะ|table\s?cloth|tablecloth|กันน้ำ.*โต๊ะ|โต๊ะ.*กันน้ำ/i, "waterproof_tablecloth"],
    [/sport_shirt|เสื้อกีฬา|sport\s?shirt/i, "sport_shirt"],
    [/เสื้อ|shirt|t-?shirt|tee|blouse|polo/i, "shirt"],
    [/กระโปรง|skirt/i, "skirt"],
    [/เดรส|dress/i, "dress"],
    [/กางเกง|pants|trousers/i, "pants"],
    [/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|ผิว/i, "skincare"],
    [/กระบอกน้ำ|ขวดน้ำ|กระติก|แก้วเก็บ|tumbler|drinkware|water\s?bottle/i, "drinkware"],
    [/หมอนรองคอ|travel_pillow|neck\s?pillow/i, "travel_pillow"],
    [/กล่องเก็บ|storage\s?box/i, "storage_box"],
    [/ชั้นวางรองเท้า|shoe\s?rack/i, "shoe_rack"],
    [/จัดเก็บ|ชั้นวาง|storage|organizer/i, "home_storage"],
    [/ครัว|ถาดน้ำแข็ง|หม้อ|กระทะ|kitchen|kitchenware/i, "kitchenware"],
    [/สัตว์เลี้ยง|pet|cat|dog/i, "pet_supply"],
    [/รถ|automotive|dashcam|กล้องติดรถ|ยาง|จัมป์|แบต/i, "automotive_accessory"],
    [/มือถือ|หูฟัง|แกดเจ็ต|gadget|electronics|สมาร์ทวอทช์|charger|usb/i, "electronics_accessory"],
    [/แต่งหน้า|makeup|beauty_tool|แปรงแต่งหน้า|พัฟ|ฟองน้ำ/i, "beauty_tool"],
    [/ต่างหู|earring/i, "earring"],
    [/สร้อย|necklace/i, "necklace"],
    [/แหวน|ring/i, "ring"],
    [/กำไล|bracelet|bangle/i, "bracelet"],
    [/เครื่องประดับ|jewelry/i, "jewelry"],
    [/กระเป๋าสตางค์|wallet/i, "wallet"],
    [/เป้|backpack/i, "backpack"],
    [/กระเป๋าถือ|handbag/i, "handbag"],
    [/กระเป๋า|bag|crossbody/i, "bag"],
    [/รองเท้า|shoe|sneaker|running_shoes|sport_shoes/i, "shoes"],
    [/อาหาร|ขนม|snack|food|เครื่องดื่ม|น้ำพริก/i, "food"]
  ];
  const mappedType = profileRules.find(([pattern]) => pattern.test(haystack))?.[1];
  return mappedType ? SHOPEE_PRODUCT_TYPE_PROFILE_BY_TYPE[mappedType] : undefined;
}

function getShopeeEntityBasedMainUseCase(productEntity?: string) {
  const entity = compactProductText(normalizeTextEncoding(productEntity ?? "").trim(), 64);
  if (!entity || /^(?:สินค้า|ไอเทม|ของใช้ทั่วไป|ไอเทมใช้งานประจำวัน)$/iu.test(entity)) return "";
  if (/เทียนหอม|scented\s?candle|aroma\s?candle|soy\s?wax|apple\s*cranberry/i.test(entity)) return "ใช้เพิ่มกลิ่นหอมภายในห้อง";
  if (/ผ้าปูโต๊ะ|table\s?cloth|tablecloth/i.test(entity)) return "ใช้ปูโต๊ะเพื่อกันน้ำและคราบเปื้อน";
  return `ใช้สำหรับ${entity}`;
}

function normalizeShopeeHumanReadableEntityText(value?: string) {
  return normalizeTextEncoding(value ?? "")
    .replace(/\(\s*ab\s*roller\s*\)?/giu, " AB Roller")
    .replace(/\(\s*ab\s*$/giu, " AB Roller")
    .replace(/\(\s*usb\s*\)?/giu, " USB")
    .replace(/\(\s*type\s*-\s*c\s*\)?/giu, " Type-C")
    .replace(/\(\s*typec\s*\)?/giu, " Type-C")
    .replace(/\s+\)/gu, ")")
    .replace(/\s+([,.:;!?])/gu, "$1")
    .replace(/[\s([{/&-]*(?:\.{3}|…)?$/u, "")
    .replace(/[([{]\s*$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeShopeeProductUnderstandingReadability<T extends ShopeeProductUnderstanding>(understanding: T): T {
  const productEntity = normalizeShopeeHumanReadableEntityText(understanding.productEntity);
  const cleanedTitle = normalizeShopeeHumanReadableEntityText(understanding.cleanedTitle);
  return {
    ...understanding,
    productEntity: productEntity || understanding.productEntity,
    cleanedTitle: cleanedTitle || productEntity || understanding.cleanedTitle,
    whatItIs: normalizeShopeeHumanReadableEntityText(understanding.whatItIs) || understanding.whatItIs,
    mainUseCase: normalizeShopeeHumanReadableEntityText(understanding.mainUseCase) || understanding.mainUseCase,
    targetAudience: normalizeShopeeHumanReadableEntityText(understanding.targetAudience) || understanding.targetAudience,
    targetUser: normalizeShopeeHumanReadableEntityText(understanding.targetUser) || understanding.targetUser,
    keySellingPoint: normalizeShopeeHumanReadableEntityText(understanding.keySellingPoint) || understanding.keySellingPoint,
    realUsageScenario: normalizeShopeeHumanReadableEntityText(understanding.realUsageScenario) || understanding.realUsageScenario,
    captionAngle: normalizeShopeeHumanReadableEntityText(understanding.captionAngle) || understanding.captionAngle
  };
}

function getShopeeProductUnderstandingCoverageReport() {
  return [...shopeeProductUnderstandingCoverageStats.entries()]
    .map(([productType, stats]) => ({ productType, ...stats }))
    .sort((a, b) => b.failureCount - a.failureCount || b.missingMainUseCaseCount - a.missingMainUseCaseCount || b.entityCount - a.entityCount);
}

function logShopeeProductUnderstandingCoverageReport() {
  if (shopeeProductUnderstandingCoverageLogged) return;
  shopeeProductUnderstandingCoverageLogged = true;
  const missingMainUseCaseMapping = SHOPEE_KNOWN_PRODUCT_TYPES.filter((type) => !getShopeeMappedMainUseCase(type, type));
  const incompleteProductTypeProfiles = SHOPEE_PRODUCT_TYPE_LIBRARY
    .filter((profile) => !profile.mainUseCase || !profile.targetAudience || !profile.painPoint || !profile.dailyBenefit)
    .map((profile) => profile.productType);
  console.info("[PRODUCT_UNDERSTANDING_COVERAGE_REPORT]", {
    coverageReport: getShopeeProductUnderstandingCoverageReport(),
    knownProductTypes: [...SHOPEE_KNOWN_PRODUCT_TYPES],
    mappedProductTypes: Object.keys(SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE),
    missingMainUseCaseMapping,
    incompleteProductTypeProfiles
  });
}

function extractShopeeKnownBrand(text: string) {
  if (/coway|โคเวย์/i.test(text)) return "Coway";
  if (/tempur/i.test(text)) return "TEMPUR";
  if (/maui\s*&\s*sons|maui\s+and\s+sons/i.test(text)) return "MAUI & SONS";
  if (/dior/i.test(text)) return "Dior";
  if (/bosch/i.test(text)) return "Bosch";
  if (/yonex/i.test(text)) return "YONEX";
  if (/adidas/i.test(text)) return "Adidas";
  if (/insta360/i.test(text)) return "Insta360";
  return undefined;
}

function extractShopeeKnownModel(text: string) {
  const coreMatch = text.match(/(?:รุ่น\s*)?(core)\b/iu);
  if (coreMatch) return "Core";
  const modelMatch = text.match(/(?:รุ่น\s*)?([A-Za-z]{1,6}[-\s]?\d{2,}[A-Za-z0-9-]*)/u);
  return modelMatch?.[1]?.replace(/\s+/g, "").trim();
}

function extractShopeeProductEntity(product: ShopeeProductRecord): ShopeeProductEntity {
  const titleInfo = getShopeeCleanedProductTitleInfo(product.productName);
  const rawTitle = titleInfo.rawTitle;
  const cleanedTitle = titleInfo.cleanedTitle;
  const haystack = normalizeTextEncoding([
    cleanedTitle,
    rawTitle,
    product.productDescription,
    getShopeeProductImageSourceText(product)
  ].filter(Boolean).join(" ")).toLowerCase();

  if (/เทียนหอม|scented\s?candle|aroma\s?candle|soy\s?wax|apple\s*cranberry/i.test(haystack)) {
    const productEntity = /apple\s*cranberry|แอปเปิล\s*แครนเบอร์รี|แอปเปิ้ล\s*แครนเบอร์รี่/i.test(haystack)
      ? "เทียนหอม Apple Cranberry"
      : "เทียนหอม";
    return {
      rawTitle,
      cleanedTitle: compactProductText(productEntity, 64) || cleanedTitle,
      productEntity,
      brand: extractShopeeKnownBrand(haystack),
      model: extractShopeeKnownModel(haystack),
      productType: "scented_candle",
      whatItIs: "เทียนหอมสำหรับเพิ่มกลิ่นและบรรยากาศในห้อง",
      mainUseCase: "ใช้เพิ่มกลิ่นหอมภายในห้อง",
      keySellingPoint: "ช่วยให้มุมพักผ่อนมีกลิ่นหอมและบรรยากาศผ่อนคลายขึ้น",
      realUsageScenario: "จุดหรือวางในห้องนั่งเล่น ห้องนอน หรือมุมพักผ่อน",
      targetUser: "คนที่อยากให้ห้องมีกลิ่นหอมและบรรยากาศน่าอยู่",
      targetAudience: "คนที่อยากให้ห้องมีกลิ่นหอม",
      captionAngle: "เล่าการใช้เทียนหอมเพื่อเพิ่มกลิ่นในห้องและสร้างบรรยากาศผ่อนคลาย",
      confidence: 94,
      removedNoiseWords: titleInfo.removedNoiseWords
    };
  }

  if (/ผ้าปูโต๊ะ|table\s?cloth|tablecloth|กันน้ำ.*โต๊ะ|โต๊ะ.*กันน้ำ/i.test(haystack)) {
    const productEntity = /กันน้ำ|waterproof/i.test(haystack) ? "ผ้าปูโต๊ะกันน้ำ" : "ผ้าปูโต๊ะ";
    return {
      rawTitle,
      cleanedTitle: compactProductText(productEntity, 64) || cleanedTitle,
      productEntity,
      brand: extractShopeeKnownBrand(haystack),
      model: extractShopeeKnownModel(haystack),
      productType: /กันน้ำ|waterproof/i.test(haystack) ? "waterproof_tablecloth" : "tablecloth",
      whatItIs: "ผ้าปูโต๊ะสำหรับคลุมโต๊ะและช่วยดูแลพื้นผิวโต๊ะ",
      mainUseCase: /กันน้ำ|waterproof/i.test(haystack)
        ? "ใช้ปูโต๊ะเพื่อกันน้ำและคราบเปื้อน"
        : "ใช้ปูโต๊ะเพื่อแต่งโต๊ะและช่วยลดคราบเปื้อน",
      keySellingPoint: /กันน้ำ|waterproof/i.test(haystack)
        ? "ช่วยกันน้ำและเช็ดคราบบนโต๊ะได้ง่ายขึ้น"
        : "ช่วยให้โต๊ะดูเรียบร้อยและใช้งานได้สบายขึ้น",
      realUsageScenario: "ปูบนโต๊ะกินข้าว โต๊ะทำงาน หรือโต๊ะอเนกประสงค์",
      targetUser: "คนที่ใช้โต๊ะกินข้าว โต๊ะทำงาน หรือโต๊ะอเนกประสงค์",
      targetAudience: "คนที่ใช้โต๊ะกินข้าว โต๊ะทำงาน หรือโต๊ะอเนกประสงค์",
      captionAngle: "เล่าการใช้ผ้าปูโต๊ะกับโต๊ะจริง เน้นกันน้ำ กันคราบ และเช็ดทำความสะอาดง่าย",
      confidence: 94,
      removedNoiseWords: titleInfo.removedNoiseWords
    };
  }

  if (/tempur|travel\s?pillow|neck\s?pillow|หมอนรองคอ|หมอนเดินทาง/i.test(haystack)) {
    const brand = extractShopeeKnownBrand(haystack);
    const productEntity = compactProductText(["หมอนรองคอ", brand].filter(Boolean).join(" "), 64);
    return {
      rawTitle,
      cleanedTitle: productEntity || cleanedTitle,
      productEntity: productEntity || "หมอนรองคอเดินทาง",
      brand,
      model: extractShopeeKnownModel(haystack),
      productType: "travel_pillow",
      whatItIs: "หมอนรองคอสำหรับใช้ระหว่างเดินทาง",
      mainUseCase: "รองคอระหว่างเดินทางด้วยรถ เครื่องบิน หรือรถไฟ",
      keySellingPoint: "ช่วยรองรับต้นคอให้เดินทางไกลได้สบายขึ้น",
      realUsageScenario: "ใช้ในรถ บนเครื่องบิน หรือระหว่างนั่งพักระหว่างเดินทาง",
      targetUser: "นักเดินทางหรือคนที่ต้องนั่งรถและเครื่องบินนาน",
      targetAudience: "นักเดินทาง",
      captionAngle: "เล่าการใช้หมอนรองคอระหว่างเดินทางไกล ช่วยรองรับต้นคอในรถหรือบนเครื่องบิน",
      confidence: 96,
      removedNoiseWords: titleInfo.removedNoiseWords
    };
  }

  if (/(ไส้กรอง|filter\s?(?:cartridge|element|replacement)|อะไหล่|อุปกรณ์เสริม|accessory).*(เครื่องกรองน้ำ|กรองน้ำ|water\s?(?:purifier|filter))|(เครื่องกรองน้ำ|กรองน้ำ|water\s?(?:purifier|filter)).*(ไส้กรอง|filter\s?(?:cartridge|element|replacement)|อะไหล่|อุปกรณ์เสริม|accessory)/i.test(haystack)) {
    const brand = extractShopeeKnownBrand(haystack);
    const productEntity = /ไส้กรอง|filter\s?(?:cartridge|element|replacement)/i.test(haystack)
      ? "ไส้กรองเครื่องกรองน้ำ"
      : "อุปกรณ์เครื่องกรองน้ำ";
    return {
      rawTitle,
      cleanedTitle: compactProductText([productEntity, brand].filter(Boolean).join(" "), 64) || cleanedTitle,
      productEntity,
      brand,
      model: extractShopeeKnownModel(haystack),
      productType: "water_purifier_accessory",
      whatItIs: "อุปกรณ์หรือไส้กรองสำหรับใช้งานร่วมกับเครื่องกรองน้ำ",
      mainUseCase: "ใช้เปลี่ยนหรือใช้งานร่วมกับเครื่องกรองน้ำเพื่อกรองน้ำดื่ม",
      keySellingPoint: "ช่วยให้เครื่องกรองน้ำพร้อมกรองน้ำดื่มสะอาดได้ต่อเนื่อง",
      realUsageScenario: "เปลี่ยนกับเครื่องกรองน้ำในบ้าน คอนโด หรือมุมครัว",
      targetUser: "คนที่มีเครื่องกรองน้ำและต้องการเปลี่ยนไส้กรองหรืออะไหล่",
      targetAudience: "ผู้ใช้เครื่องกรองน้ำ",
      captionAngle: "เล่าเรื่องการเปลี่ยนไส้กรองหรืออุปกรณ์เครื่องกรองน้ำเพื่อให้มีน้ำดื่มสะอาดพร้อมใช้",
      confidence: 94,
      removedNoiseWords: titleInfo.removedNoiseWords
    };
  }

  if (/เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|coway|โคเวย์|water\s?(?:purifier|filter)/i.test(haystack)) {
    const brand = extractShopeeKnownBrand(haystack);
    const model = extractShopeeKnownModel(haystack);
    const productSimpleName = compactProductText([
      "เครื่องกรองน้ำ",
      brand,
      model ? `รุ่น ${model}` : ""
    ].filter(Boolean).join(" "), 64);
    return {
      rawTitle,
      cleanedTitle: productSimpleName || cleanedTitle,
      productEntity: "เครื่องกรองน้ำ",
      brand,
      model,
      productType: "เครื่องกรองน้ำ",
      whatItIs: "เครื่องกรองน้ำสำหรับใช้งานในบ้าน",
      mainUseCase: "กดน้ำดื่มสะอาดไว้ใช้ในบ้าน",
      keySellingPoint: "ช่วยให้มีน้ำดื่มพร้อมกดใช้โดยไม่ต้องซื้อน้ำขวดบ่อย",
      realUsageScenario: "วางไว้ในบ้าน คอนโด หรือมุมครัวสำหรับกดน้ำดื่มระหว่างวัน",
      targetUser: "คนอยู่บ้าน คอนโด หรือครอบครัวที่อยากมีน้ำดื่มสะอาดไว้กดใช้",
      targetAudience: "คนอยู่บ้านหรือคอนโด",
      captionAngle: "เล่าเรื่องความสะดวกของการมีน้ำดื่มสะอาดไว้กดใช้ในบ้าน ลดการซื้อน้ำขวดและเหมาะกับบ้านหรือคอนโด",
      confidence: 94,
      removedNoiseWords: titleInfo.removedNoiseWords
    };
  }

  if (/กระบอกน้ำ|ขวดน้ำ|water\s?bottle|tumbler|แก้วเก็บ|แก้วน้ำ|กระติก|เก็บความเย็น|เก็บอุณหภูมิ/i.test(haystack)) {
    const isBottle = /กระบอกน้ำ|ขวดน้ำ|water\s?bottle|bottle|กระติก/i.test(haystack);
    const productType = isBottle ? "กระบอกน้ำเก็บอุณหภูมิ" : "แก้วเก็บอุณหภูมิ";
    return {
      rawTitle,
      cleanedTitle: cleanedTitle || productType,
      productEntity: isBottle ? "กระบอกน้ำ" : "แก้วเก็บอุณหภูมิ",
      brand: extractShopeeKnownBrand(haystack),
      model: extractShopeeKnownModel(haystack),
      productType,
      whatItIs: "ภาชนะสำหรับพกน้ำหรือเครื่องดื่มและช่วยเก็บอุณหภูมิ",
      mainUseCase: "พกน้ำหรือเครื่องดื่มไปทำงาน เดินทาง หรือออกกำลังกาย",
      keySellingPoint: "ช่วยให้มีน้ำหรือเครื่องดื่มติดตัวไว้จิบระหว่างวันได้สะดวก",
      realUsageScenario: "โต๊ะทำงาน กระเป๋าเดินทาง ฟิตเนส หรือวันที่ออกไปข้างนอก",
      targetUser: "คนทำงาน คนเดินทาง หรือคนออกกำลังกายที่อยากพกน้ำติดตัว",
      targetAudience: "คนทำงาน คนเดินทาง หรือคนออกกำลังกาย",
      captionAngle: "เล่าเรื่องการพกน้ำ เก็บอุณหภูมิ และใช้จริงระหว่างทำงาน เดินทาง หรือออกกำลังกาย",
      confidence: 94,
      removedNoiseWords: titleInfo.removedNoiseWords
    };
  }

  if (/เสื้อ|shirt|t-?shirt|tee|blouse|polo|กระโปรง|skirt|เดรส|dress|กางเกง|pants|แฟชั่น|fashion/i.test(haystack) && !/รองเท้า|shoe|sneaker|ถุงเท้า|sock|กระเป๋า|bag|wallet/i.test(haystack)) {
    const productType = /sport\s?shirt|เสื้อกีฬา|maui\s*&\s*sons/i.test(haystack)
      ? "sport_shirt"
      : /กระโปรง|skirt/i.test(haystack)
      ? "กระโปรง"
      : /เดรส|dress/i.test(haystack)
        ? "เดรส"
        : /กางเกง|pants|trousers/i.test(haystack)
          ? "กางเกง"
          : /เสื้อ|shirt|t-?shirt|tee|blouse|polo/i.test(haystack)
            ? "เสื้อ"
            : "เสื้อผ้าแฟชั่น";
    const isTop = /เสื้อ|shirt|t-?shirt|tee|blouse|polo|sport_shirt/i.test(productType);
    const isSkirt = /กระโปรง/i.test(productType);
    const brand = extractShopeeKnownBrand(haystack);
    const productEntity = productType === "sport_shirt"
      ? compactProductText(["เสื้อกีฬา", brand].filter(Boolean).join(" "), 64)
      : productType;
    const wearAction = isSkirt
      ? "ใส่แมตช์กับเสื้อให้เข้ากับวันทำงาน ไปเที่ยว หรือวันลำลอง"
      : isTop
        ? "ใส่แมตช์กับกางเกงหรือกระโปรงได้ทั้งวันทำงาน ไปเที่ยว และวันลำลอง"
        : "ใส่แต่งตัวให้เข้ากับวันทำงาน ไปเที่ยว หรือวันลำลอง";
    const mainUseCase = productType === "sport_shirt"
      ? "สวมใส่ออกกำลังกาย เล่นกีฬา หรือแต่งลุคลำลองแบบสปอร์ต"
      : wearAction;
    return {
      rawTitle,
      cleanedTitle: productEntity || cleanedTitle || productType,
      productEntity,
      brand,
      model: extractShopeeKnownModel(haystack),
      productType,
      whatItIs: productType === "sport_shirt" ? "เสื้อกีฬาสำหรับออกกำลังกายและใส่ลำลอง" : `${productType}สำหรับแต่งตัวและแมตช์ลุค`,
      mainUseCase,
      keySellingPoint: "ทรง ดีไซน์ และเนื้อผ้าช่วยให้แต่งตัวได้ง่ายขึ้น",
      realUsageScenario: productType === "sport_shirt" ? "ใส่ตอนออกกำลังกาย เล่นกีฬา เดินทาง หรือวันลำลอง" : "ใส่ไปทำงาน ไปเที่ยว คาเฟ่ หรือวันสบาย ๆ",
      targetUser: productType === "sport_shirt" ? "ผู้ชายหรือคนที่หาเสื้อกีฬาใส่ออกกำลังกายและใส่ลำลอง" : "คนที่หาเสื้อผ้าใส่ง่าย แมตช์ง่าย และใช้ได้หลายโอกาส",
      targetAudience: productType === "sport_shirt" ? "ผู้ชาย" : "คนที่หาเสื้อผ้าใส่ง่าย",
      captionAngle: productType === "sport_shirt"
        ? "รีวิวเสื้อกีฬาจากการใส่จริง เน้นความคล่องตัว เนื้อผ้า ทรง และลุคสปอร์ต"
        : "รีวิวจากตัวเสื้อผ้าจริง เน้นการใส่สบาย ทรง ดีไซน์ เนื้อผ้า และการแมตช์ลุค",
      confidence: productType === "sport_shirt" ? 95 : 90,
      removedNoiseWords: titleInfo.removedNoiseWords
    };
  }

  const productType = inferShopeeFallbackProductType(product, [
    cleanedTitle,
    product.productDescription,
    getShopeeProductImageSourceText(product)
  ].filter(Boolean).join(" ").toLowerCase());
  return {
    rawTitle,
    cleanedTitle: cleanedTitle || productType,
    productEntity: productType,
    brand: extractShopeeKnownBrand(haystack),
    model: extractShopeeKnownModel(haystack),
    productType,
    whatItIs: productType,
    mainUseCase: "",
    keySellingPoint: "",
    realUsageScenario: "",
    targetUser: "",
    captionAngle: "",
    confidence: 35,
    removedNoiseWords: titleInfo.removedNoiseWords
  };
}

function getShopeeFallbackUnderstandingDetails(productType: string, haystack: string) {
  const normalizedType = normalizeTextEncoding(productType);
  const text = `${normalizedType} ${haystack}`;
  const details: Partial<Pick<
    ShopeeProductEntity,
    "productEntity" | "productType" | "whatItIs" | "mainUseCase" | "keySellingPoint" | "realUsageScenario" | "targetUser" | "targetAudience" | "captionAngle" | "confidence"
  >> = {};

  if (/travel_pillow|หมอนรองคอ|travel\s?pillow|neck\s?pillow|tempur/i.test(text)) {
    details.productEntity = /tempur/i.test(text) ? "หมอนรองคอ TEMPUR" : "หมอนรองคอเดินทาง";
    details.productType = "travel_pillow";
    details.whatItIs = "หมอนรองคอสำหรับใช้ระหว่างเดินทาง";
    details.mainUseCase = "รองคอระหว่างเดินทางด้วยรถ เครื่องบิน หรือรถไฟ";
    details.keySellingPoint = "ช่วยรองรับต้นคอให้เดินทางไกลได้สบายขึ้น";
    details.realUsageScenario = "ใช้ในรถ บนเครื่องบิน หรือระหว่างนั่งพักระหว่างเดินทาง";
    details.targetUser = "นักเดินทางหรือคนที่ต้องนั่งรถและเครื่องบินนาน";
    details.targetAudience = "นักเดินทาง";
    details.captionAngle = "เล่าการใช้หมอนรองคอระหว่างเดินทางไกลในรถหรือบนเครื่องบิน";
    details.confidence = 92;
  } else if (/water_purifier_accessory|ไส้กรองเครื่องกรองน้ำ|อุปกรณ์เครื่องกรองน้ำ|filter\s?(?:cartridge|element|replacement)/i.test(text)) {
    details.productEntity = /ไส้กรอง|filter/i.test(text) ? "ไส้กรองเครื่องกรองน้ำ" : "อุปกรณ์เครื่องกรองน้ำ";
    details.productType = "water_purifier_accessory";
    details.whatItIs = "อุปกรณ์หรือไส้กรองสำหรับใช้งานร่วมกับเครื่องกรองน้ำ";
    details.mainUseCase = "ใช้เปลี่ยนหรือใช้งานร่วมกับเครื่องกรองน้ำเพื่อกรองน้ำดื่ม";
    details.keySellingPoint = "ช่วยให้เครื่องกรองน้ำพร้อมกรองน้ำดื่มสะอาดได้ต่อเนื่อง";
    details.realUsageScenario = "เปลี่ยนกับเครื่องกรองน้ำในบ้าน คอนโด หรือมุมครัว";
    details.targetUser = "คนที่มีเครื่องกรองน้ำและต้องการเปลี่ยนไส้กรองหรืออะไหล่";
    details.targetAudience = "ผู้ใช้เครื่องกรองน้ำ";
    details.captionAngle = "เล่าเรื่องการเปลี่ยนไส้กรองหรืออุปกรณ์เครื่องกรองน้ำเพื่อให้มีน้ำดื่มสะอาดพร้อมใช้";
    details.confidence = 90;
  } else if (/เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|water\s?(?:purifier|filter)|coway|โคเวย์/i.test(text)) {
    details.productType = "water_purifier";
    details.mainUseCase = "กดน้ำดื่มสะอาดไว้ใช้ในบ้าน คอนโด หรือมุมครัว";
    details.targetAudience = "คนอยู่บ้านหรือคอนโด";
    details.confidence = 88;
  } else if (/sport_shirt|เสื้อกีฬา|sport\s?shirt/i.test(text)) {
    details.productEntity = "เสื้อกีฬา";
    details.productType = "sport_shirt";
    details.whatItIs = "เสื้อกีฬาสำหรับออกกำลังกายและใส่ลำลอง";
    details.mainUseCase = "สวมใส่ออกกำลังกาย เล่นกีฬา หรือแต่งลุคลำลองแบบสปอร์ต";
    details.keySellingPoint = "เนื้อผ้า ทรง และดีไซน์ช่วยให้เคลื่อนไหวคล่องตัว";
    details.realUsageScenario = "ใส่ตอนออกกำลังกาย เล่นกีฬา เดินทาง หรือวันลำลอง";
    details.targetUser = "ผู้ชายหรือคนที่หาเสื้อกีฬาใส่ออกกำลังกายและใส่ลำลอง";
    details.targetAudience = "ผู้ชาย";
    details.captionAngle = "รีวิวเสื้อกีฬาจากการใส่จริง เน้นความคล่องตัว เนื้อผ้า ทรง และลุคสปอร์ต";
    details.confidence = 90;
  } else if (/เสื้อ|กระโปรง|เดรส|กางเกง|เสื้อผ้า|แฟชั่น|shirt|skirt|dress|pants/i.test(text)) {
    details.productType = /กระโปรง|skirt/i.test(text) ? "skirt" : /เดรส|dress/i.test(text) ? "dress" : /กางเกง|pants/i.test(text) ? "pants" : "shirt";
    details.mainUseCase = "ใส่แต่งตัวให้เข้ากับวันทำงาน ไปเที่ยว หรือวันลำลอง";
    details.targetAudience = "คนที่หาเสื้อผ้าใส่ง่าย";
    details.confidence = 82;
  } else if (/กระบอกน้ำ|ขวดน้ำ|กระติก|แก้วเก็บ|tumbler|water\s?bottle|เก็บอุณหภูมิ|เก็บความเย็น/i.test(text)) {
    details.productType = "drinkware";
    details.mainUseCase = "พกน้ำหรือเครื่องดื่มไปทำงาน เดินทาง หรือออกกำลังกาย";
    details.targetAudience = "คนทำงาน คนเดินทาง หรือคนออกกำลังกาย";
    details.confidence = 86;
  } else if (/กล้องติดรถ|dash\s?cam|บันทึกภาพรถ/i.test(text)) {
    details.productType = "dashcam";
    details.mainUseCase = "ติดหน้ารถเพื่อบันทึกเส้นทาง เหตุการณ์ และหลักฐานระหว่างขับขี่";
    details.targetAudience = "คนใช้รถ";
    details.confidence = 86;
  } else if (/รองเท้า|running\s?shoe|sneaker|shoe/i.test(text)) {
    details.productType = /วิ่ง|running/i.test(text) ? "running_shoes" : "sport_shoes";
    details.mainUseCase = "ใส่เดิน วิ่ง หรือทำกิจกรรมที่ต้องเคลื่อนไหว";
    details.targetAudience = "คนที่วิ่ง ออกกำลังกาย หรือเดินเยอะ";
    details.confidence = 82;
  } else if (/กระเป๋า|bag|เป้|คาดอก|crossbody|wallet/i.test(text)) {
    details.productType = "bag";
    details.mainUseCase = "ใส่ของจุกจิก โทรศัพท์ กระเป๋าสตางค์ หรือของใช้ส่วนตัวเวลาออกจากบ้าน";
    details.targetAudience = "คนที่เดินทางหรือพกของออกจากบ้านบ่อย";
    details.confidence = 80;
  } else if (/โคมไฟ|lamp|desk\s?light|led\s?light/i.test(text)) {
    details.productType = "desk_lamp";
    details.mainUseCase = "เพิ่มแสงสว่างตอนอ่านหนังสือ ทำงาน หรือใช้คอม";
    details.targetAudience = "คนทำงานหรืออ่านหนังสือ";
    details.confidence = 78;
  } else if (/หูฟัง|earbud|earphone|headphone|bluetooth|ลำโพง|speaker/i.test(text)) {
    details.productType = "audio_gadget";
    details.mainUseCase = "ใช้ฟังเสียงระหว่างเดินทาง ทำงาน หรือพักผ่อน";
    details.targetAudience = "คนใช้มือถือหรือฟังเพลงบ่อย";
    details.confidence = 78;
  } else if (/สกินแคร์|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|ผิว/i.test(text)) {
    details.productType = "skincare";
    details.mainUseCase = /กันแดด|sunscreen|spf/i.test(text)
      ? "ทาก่อนออกแดดหรือก่อนแต่งหน้าเพื่อช่วยดูแลผิวระหว่างวัน"
      : "ทาหลังล้างหน้าในขั้นตอนดูแลผิว เพื่อช่วยให้ผิวดูชุ่มชื้นและพร้อมแต่งหน้าขึ้น";
    details.targetAudience = "คนที่มองหาไอเทมดูแลผิว";
    details.keySellingPoint = /กันแดด|sunscreen|spf/i.test(text)
      ? "เนื้อใช้ประจำวันได้ง่าย เหมาะกับวันที่ต้องออกแดดหรืออยู่ห้องแอร์"
      : "เนื้อบางเบา ใช้ง่ายใน routine และเหมาะกับวันที่อยากให้ผิวดูชุ่มชื้นขึ้น";
    details.realUsageScenario = /กันแดด|sunscreen|spf/i.test(text)
      ? "ทาช่วงเช้าก่อนออกจากบ้านหรือก่อนแต่งหน้า"
      : "ใช้หลังล้างหน้า ก่อนลงครีมหรือก่อนแต่งหน้า";
    details.captionAngle = /กันแดด|sunscreen|spf/i.test(text)
      ? "รีวิวกันแดดจากการใช้ตอนเช้า เน้นเนื้อสัมผัส ใช้ก่อนแต่งหน้า และวันที่ต้องออกแดด"
      : "รีวิวสกินแคร์จากการใช้จริง เน้นเนื้อสัมผัส ซึมไว ความชุ่มชื้น และใช้ก่อนแต่งหน้า";
    details.confidence = 78;
  }

  const profile = getShopeeProductTypeProfile(details.productType || normalizedType, text);
  if (profile) {
    details.productType = details.productType || profile.productType;
    details.productEntity = details.productEntity || normalizedType;
    details.whatItIs = details.whatItIs || normalizedType;
    details.mainUseCase = details.mainUseCase || profile.mainUseCase;
    details.targetAudience = details.targetAudience || profile.targetAudience;
    details.keySellingPoint = details.keySellingPoint || profile.dailyBenefit;
    details.realUsageScenario = details.realUsageScenario || profile.mainUseCase;
    details.targetUser = details.targetUser || profile.targetAudience;
    details.captionAngle = details.captionAngle || `เล่าการใช้${details.productEntity || normalizedType}จากสถานการณ์จริง โดยยึดตัวสินค้าเป็นหลัก`;
    details.confidence = Math.max(details.confidence ?? 0, 72);
  }

  if (details.mainUseCase) {
    details.productEntity = details.productEntity || normalizedType;
    details.whatItIs = details.whatItIs || normalizedType;
    details.keySellingPoint = details.keySellingPoint || `ช่วยให้ใช้${details.productEntity}ได้เข้ากับสถานการณ์จริง`;
    details.realUsageScenario = details.realUsageScenario || `ใช้${details.productEntity}ในวันที่ต้องการความสะดวก`;
    details.targetUser = details.targetUser || details.targetAudience || `คนที่กำลังมองหา${details.productEntity}`;
    details.captionAngle = details.captionAngle || `เล่าประโยชน์ของ${details.productEntity}จากการใช้งานจริง`;
  }

  return details;
}

function getShopeeProductUnderstandingFailureReasons(understanding: Pick<ShopeeProductUnderstanding, "productEntity" | "productType" | "mainUseCase" | "confidence">) {
  const reasons: string[] = [];
  if (!understanding.productEntity?.trim()) reasons.push("missing_product_entity");
  if (!understanding.productType?.trim()) reasons.push("missing_product_type");
  if (!understanding.mainUseCase?.trim()) reasons.push("missing_main_use_case");
  if (/^(?:สินค้า|ไอเทม|ของใช้ทั่วไป|ไอเทมใช้งานประจำวัน|general|generic_product|home|living|daily_life|home_solution)$/iu.test(understanding.productType?.trim() ?? "")) {
    reasons.push("generic_product_type");
  }
  if (/^(?:สินค้า|ไอเทม|ของใช้ทั่วไป|ไอเทมใช้งานประจำวัน)$/iu.test(understanding.productEntity?.trim() ?? "")) {
    reasons.push("generic_product_entity");
  }
  return reasons;
}

function recordShopeeProductUnderstandingCoverage(understanding: ShopeeProductUnderstanding) {
  const productType = normalizeShopeeProductTypeKey(understanding.productType) || "unknown";
  const current = shopeeProductUnderstandingCoverageStats.get(productType) ?? {
    entityCount: 0,
    successCount: 0,
    failureCount: 0,
    missingMainUseCaseCount: 0
  };
  current.entityCount += understanding.productEntity?.trim() ? 1 : 0;
  if (understanding.failureReasons.length) current.failureCount += 1;
  else current.successCount += 1;
  if (understanding.failureReasons.includes("missing_main_use_case")) current.missingMainUseCaseCount += 1;
  shopeeProductUnderstandingCoverageStats.set(productType, current);
}

function getFirstValidShopeeProductImageUrl(product: ShopeeProductRecord) {
  return [
    ...(product.productImageUrls ?? []),
    product.productImageUrl
  ].map((url) => String(url ?? "").trim()).find(Boolean) ?? "";
}

function normalizeShopeeVisionProductType(productType?: string, productEntity?: string) {
  const profile = getShopeeProductTypeProfile(productType, productEntity);
  return profile?.productType || normalizeShopeeProductTypeKey(productType) || normalizeTextEncoding(productType ?? "").trim();
}

function mergeShopeeVisionUnderstanding(
  product: ShopeeProductRecord,
  textUnderstanding: ShopeeProductUnderstanding,
  vision: ShopeeVisionUnderstandingResult
): ShopeeProductUnderstanding {
  const visionProductEntity = compactProductText(normalizeTextEncoding(vision.visionProductEntity || ""), 80);
  const visionProductType = normalizeShopeeVisionProductType(vision.visionProductType, visionProductEntity);
  const visionMainUseCase = compactProductText(
    normalizeTextEncoding(
      vision.visionMainUseCase ||
      getShopeeMappedMainUseCase(visionProductType, visionProductEntity) ||
      getShopeeEntityBasedMainUseCase(visionProductEntity)
    ),
    120
  );
  const visionTargetAudience = compactProductText(normalizeTextEncoding(vision.visionTargetAudience || ""), 100);
  const useVisionPrimary = vision.visionConfidence >= 75 && textUnderstanding.confidence < 80;
  const visionWinsDisagreement = vision.visionConfidence > textUnderstanding.confidence && (
    Boolean(visionProductType && visionProductType !== normalizeShopeeProductTypeKey(textUnderstanding.productType)) ||
    Boolean(visionProductEntity && visionProductEntity !== textUnderstanding.productEntity)
  );
  const shouldUseVision = useVisionPrimary || visionWinsDisagreement;
  const productEntity = shouldUseVision && visionProductEntity ? visionProductEntity : textUnderstanding.productEntity;
  const productType = shouldUseVision && visionProductType ? visionProductType : textUnderstanding.productType;
  const mainUseCase = shouldUseVision && visionMainUseCase
    ? visionMainUseCase
    : textUnderstanding.mainUseCase || getShopeeMappedMainUseCase(productType, productEntity) || getShopeeEntityBasedMainUseCase(productEntity);
  const targetAudience = shouldUseVision && visionTargetAudience
    ? visionTargetAudience
    : textUnderstanding.targetAudience;
  const confidence = shouldUseVision
    ? Math.max(vision.visionConfidence, textUnderstanding.confidence)
    : textUnderstanding.confidence;
  const merged: ShopeeProductUnderstanding = normalizeShopeeProductUnderstandingReadability({
    ...textUnderstanding,
    productEntity,
    cleanedTitle: shouldUseVision && visionProductEntity ? visionProductEntity : textUnderstanding.cleanedTitle,
    productType,
    whatItIs: shouldUseVision && visionProductEntity ? visionProductEntity : textUnderstanding.whatItIs,
    mainUseCase,
    targetAudience,
    targetUser: targetAudience || textUnderstanding.targetUser,
    keySellingPoint: shouldUseVision && visionProductEntity
      ? textUnderstanding.keySellingPoint || `ช่วยให้เลือกใช้${visionProductEntity}ได้ตรงกับสินค้าที่เห็นจริง`
      : textUnderstanding.keySellingPoint,
    realUsageScenario: shouldUseVision && mainUseCase
      ? mainUseCase
      : textUnderstanding.realUsageScenario,
    captionAngle: shouldUseVision && productEntity
      ? `เล่าการใช้${productEntity}จากตัวสินค้าที่เห็นจริง โดยไม่อ้างหมวดกว้าง`
      : textUnderstanding.captionAngle,
    confidence,
    source: shouldUseVision ? "vision_rescue" : "merged",
    fallbackUsed: textUnderstanding.fallbackUsed || shouldUseVision,
    visualEvidence: vision.visualEvidence,
    failureReasons: []
  });
  merged.failureReasons = getShopeeProductUnderstandingFailureReasons(merged);
  merged.recognitionStatus = merged.failureReasons.length
    ? "failed"
    : merged.fallbackUsed
      ? "fallback"
      : "recognized";
  recordShopeeProductUnderstandingCoverage(merged);
  console.info("[PRODUCT_UNDERSTANDING_MERGED]", {
    productId: product.productId,
    source: merged.source,
    productEntity: merged.productEntity,
    productType: merged.productType,
    mainUseCase: merged.mainUseCase,
    targetAudience: merged.targetAudience,
    confidence: merged.confidence
  });
  return merged;
}

function extractShopeeProductUnderstanding(product: ShopeeProductRecord): ShopeeProductUnderstanding {
  const entity = extractShopeeProductEntity(product);
  const haystack = getShopeeStoryboardInputText({
    ...product,
    productName: entity.cleanedTitle || product.productName
  });
  const fallback = getShopeeFallbackUnderstandingDetails(entity.productType, haystack);
  const imageCount = Array.from(new Set([
    product.productImageUrl,
    ...(product.productImageUrls ?? [])
  ].map((url) => String(url ?? "").trim()).filter(Boolean))).length;
  const productEntity = fallback.productEntity || entity.productEntity;
  const productType = fallback.productType || entity.productType;
  const mappedMainUseCase = getShopeeMappedMainUseCase(productType, productEntity);
  const entityBridgeMainUseCase = productEntity && imageCount > 0 ? getShopeeEntityBasedMainUseCase(productEntity) : "";
  const mainUseCase = entity.mainUseCase || fallback.mainUseCase || mappedMainUseCase || entityBridgeMainUseCase || "";
  const fallbackUsed = Boolean(
    (!entity.mainUseCase && fallback.mainUseCase) ||
    (!entity.mainUseCase && !fallback.mainUseCase && mappedMainUseCase) ||
    (!entity.mainUseCase && !fallback.mainUseCase && !mappedMainUseCase && entityBridgeMainUseCase) ||
    (fallback.productType && fallback.productType !== entity.productType) ||
    (fallback.productEntity && fallback.productEntity !== entity.productEntity)
  );
  const bridgeKeySellingPoint = entityBridgeMainUseCase
    ? `ช่วยให้เลือกใช้${productEntity}ได้ตรงกับประเภทสินค้า`
    : "";
  const bridgeRealUsageScenario = entityBridgeMainUseCase
    ? `ใช้${productEntity}ตามลักษณะสินค้าที่ระบุ`
    : "";
  const understanding: ShopeeProductUnderstanding = normalizeShopeeProductUnderstandingReadability({
    ...entity,
    productEntity,
    productType,
    whatItIs: fallback.whatItIs || entity.whatItIs,
    mainUseCase,
    keySellingPoint: entity.keySellingPoint || fallback.keySellingPoint || bridgeKeySellingPoint,
    realUsageScenario: entity.realUsageScenario || fallback.realUsageScenario || bridgeRealUsageScenario,
    targetUser: entity.targetUser || fallback.targetUser || fallback.targetAudience || "",
    targetAudience: entity.targetAudience || fallback.targetAudience || entity.targetUser || fallback.targetUser || "",
    captionAngle: entity.captionAngle || fallback.captionAngle || (entityBridgeMainUseCase ? `เล่าการใช้${productEntity}แบบระวังไม่เดาคุณสมบัติเกินจริง` : ""),
    confidence: Math.max(entity.confidence ?? 0, fallback.confidence ?? 0),
    source: "text",
    fallbackUsed,
    recognitionStatus: "recognized",
    failureReasons: []
  });
  understanding.failureReasons = getShopeeProductUnderstandingFailureReasons(understanding);
  understanding.recognitionStatus = understanding.failureReasons.length
    ? "failed"
    : fallbackUsed
      ? "fallback"
      : "recognized";
  recordShopeeProductUnderstandingCoverage(understanding);
  logShopeeProductUnderstandingCoverageReport();
  return understanding;
}

function getShopeeProductUnderstandingAuditPayload(product: ShopeeProductRecord, understanding: ShopeeProductUnderstanding) {
  return {
    ...getShopeeProductUnderstandingDebugPayload(product, understanding),
    source: understanding.source,
    recognitionStatus: understanding.recognitionStatus,
    fallbackUsed: understanding.fallbackUsed,
    visualEvidence: understanding.visualEvidence ?? [],
    captionInput: {
      productEntity: understanding.productEntity,
      productType: understanding.productType,
      mainUseCase: understanding.mainUseCase,
      targetAudience: understanding.targetAudience,
      confidence: understanding.confidence
    },
    coverageReport: getShopeeProductUnderstandingCoverageReport().slice(0, 50)
  };
}

function getShopeeProductUnderstandingDebugPayload(product: ShopeeProductRecord, understanding: ShopeeProductUnderstanding) {
  const imageUrls = Array.from(new Set([
    product.productImageUrl,
    ...(product.productImageUrls ?? [])
  ].map((url) => String(url ?? "").trim()).filter(Boolean)));
  return {
    productId: product.productId,
    rawTitle: understanding.rawTitle || product.productName,
    descriptionSnippet: compactProductText(product.productDescription || "", 300),
    cleanTitle: understanding.cleanedTitle,
    removedNoiseWords: understanding.removedNoiseWords,
    productEntity: understanding.productEntity,
    productType: understanding.productType,
    mainUseCase: understanding.mainUseCase,
    targetAudience: understanding.targetAudience,
    confidence: understanding.confidence,
    missingFields: understanding.failureReasons,
    imageCount: imageUrls.length
  };
}

function assertValidShopeeProductUnderstanding(understanding: ShopeeProductUnderstanding, product: ShopeeProductRecord) {
  if (!understanding.failureReasons.length) return;
  const debugPayload = getShopeeProductUnderstandingDebugPayload(product, understanding);
  console.warn("[PRODUCT_UNDERSTANDING_FAILED]", {
    ...debugPayload,
    productName: product.productName,
    failureReasons: understanding.failureReasons
  });
  console.warn("[PRODUCT_UNDERSTANDING_DEBUG]", debugPayload);
  throw new ShopeeProviderError(
    `PRODUCT_UNDERSTANDING_FAILED for ${product.productId}: ${understanding.failureReasons.join(", ")}`,
    422,
    "product_understanding_failed",
    "internal_api",
    JSON.stringify(debugPayload)
  );
}

function getShopeeStoryboardInputText(product: ShopeeProductRecord) {
  const record = product as ShopeeProductRecord & Record<string, unknown>;
  const metadata = ["productFeatures", "features", "specifications", "specs", "attributes", "variants"]
    .flatMap((key) => stringifyShopeeMetadataValue(record[key]))
    .join(" ");
  const cleanedTitle = cleanShopeeProductTitleForContent(product.productName);
  return normalizeTextEncoding([
    getShopeeProductImageSourceText(product),
    cleanedTitle,
    stripShopeeMarketplaceNoise(product.productDescription || ""),
    metadata
  ].filter(Boolean).join(" ")).toLowerCase();
}

function getShopeeStoryboardEmoji(productType: string) {
  if (/travel_pillow|หมอนรองคอ|neck\s?pillow|travel\s?pillow/i.test(productType)) return "✈️";
  if (/water_purifier|water_filter|เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|water\s?(?:purifier|filter)|coway|โคเวย์/i.test(productType)) return "💧";
  if (/ลูกแบด|แบดมินตัน/.test(productType)) return "🏸";
  if (/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|บันทึกภาพรถ/i.test(productType)) return "🚗";
  if (/กล้อง|camera|แอคชั่น/i.test(productType)) return "📷";
  if (/อาหารเสริม|วิตามิน|เวย์|โปรตีน/.test(productType)) return "💚";
  if (/เก้าอี้/.test(productType)) return "🪑";
  if (/sport_shirt|เสื้อ|กระโปรง|เดรส|กางเกง|เสื้อผ้า|แฟชั่น/.test(productType)) return "👕";
  if (/รองเท้า/.test(productType)) return "👟";
  if (/ถุงเท้า|กีฬา|วิ่ง|ฟิตเนส/.test(productType)) return "🏃";
  if (/แก้ว|กระติก|ขวดน้ำ/.test(productType)) return "🥤";
  if (/โคมไฟ|ไฟ/.test(productType)) return "💡";
  if (/หูฟัง|มือถือ|แกดเจ็ต|สมาร์ทวอทช์/.test(productType)) return "📱";
  if (/สกินแคร์|เซรั่ม|กันแดด|ผิว/.test(productType)) return "✨";
  if (/สร้อย|เครื่องประดับ|จี้|ต่างหู|แหวน|กำไล|jewelry|necklace/i.test(productType)) return "💎";
  if (/bag|กระเป๋า/.test(productType)) return "🎒";
  if (/รถ|จัมป์สตาร์ท|ยาง/.test(productType)) return "🚗";
  if (/อาหาร|ขนม|น้ำพริก|ครัว/.test(productType)) return "🍳";
  if (/สัตว์/.test(productType)) return "🐾";
  if (/อาร์ตทอย|กล่องสุ่ม|ของสะสม|ฟิกเกอร์/.test(productType)) return "🎁";
  return "✨";
}

function buildShopeeStoryboardName(fallback: string, emoji: string, product?: ShopeeProductRecord) {
  const name = getShopeeCaptionProductName(product?.productName || fallback)
    .replace(/\s+[✨🔥😍😋💯👍🎯🛒💥⭐📌📍🥤☕🧊💡🏠🏃⚽🎾🚗🍳📱💻💚💖💎👟📷⌚🎒🏸🦷🌀]+$/u, "")
    .trim();
  const safeName = name.length >= 8 && !/^(?:สินค้า|ไอเทม|ของใช้ทั่วไป)$/iu.test(name) ? name : fallback;
  return compactProductText(`${safeName} ${emoji}`.trim(), 64);
}

function makeShopeeStoryboard(
  product: ShopeeProductRecord,
  input: Omit<
    ShopeeProductStoryboard,
    | "productEntity"
    | "brand"
    | "model"
    | "productSimpleName"
    | "problemSolved"
    | "dailyBenefit"
    | "emotionalBenefit"
    | "realUsageScenario"
    | "purchaseReason"
    | "primaryPainPoint"
  >
): ShopeeProductStoryboard {
  const entity = extractShopeeProductUnderstanding(product);
  assertValidShopeeProductUnderstanding(entity, product);
  const base = {
    productSimpleName: buildShopeeStoryboardName(entity.cleanedTitle || entity.productEntity || input.productType, getShopeeStoryboardEmoji(entity.productType || input.productType), {
      ...product,
      productName: entity.cleanedTitle || product.productName
    }),
    productEntity: entity.productEntity || input.productType,
    brand: entity.brand,
    model: entity.model,
    ...input,
    productType: entity.productType || input.productType,
    whatItIs: entity.whatItIs || input.whatItIs,
    mainUseCase: entity.mainUseCase || input.mainUseCase,
    targetUser: entity.targetAudience || entity.targetUser || input.targetUser,
    keySellingPoint: entity.keySellingPoint || input.keySellingPoint,
    usageScene: entity.realUsageScenario || input.usageScene,
    captionAngle: entity.captionAngle || input.captionAngle
  };
  return enrichShopeeStoryboardForAffiliateReview(base);
}

function getShopeeStoryboardProductGroup(storyboard: Pick<ShopeeProductStoryboard, "productEntity" | "productType" | "mainUseCase" | "usageScene">) {
  const haystack = `${storyboard.productEntity} ${storyboard.productType} ${storyboard.mainUseCase} ${storyboard.usageScene}`;
  if (/travel_pillow|หมอนรองคอ|travel\s?pillow|neck\s?pillow|รองคอระหว่างเดินทาง/i.test(haystack)) return "travel_pillow";
  if (/water_purifier_accessory|ไส้กรองเครื่องกรองน้ำ|อุปกรณ์เครื่องกรองน้ำ/i.test(haystack)) return "water_filter_accessory";
  if (/water_purifier|เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|water\s?(?:purifier|filter)|coway|โคเวย์/i.test(haystack)) return "water_filter";
  if (/เสื้อ|กระโปรง|เดรส|กางเกง|เสื้อผ้า|เครื่องแต่งกาย|แฟชั่น|ใส่แมตช์|แต่งตัว/i.test(haystack) && !/รองเท้า|ถุงเท้า|กีฬา|วิ่ง/i.test(haystack)) return "apparel";
  if (/sport_shirt|เสื้อกีฬา|สวมใส่ออกกำลังกาย/i.test(haystack)) return "sports";
  if (/กระบอกน้ำ|ขวดน้ำ|กระติก|แก้วเก็บ|tumbler|water\s?bottle|เก็บอุณหภูมิ|เก็บความเย็น/i.test(haystack)) return "drinkware";
  if (/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|car\s?camera|บันทึกภาพรถ/i.test(haystack)) return "dashcam";
  if (/รถ|จัมป์|จั๊ม|ยาง|สตาร์ท|แบต/i.test(haystack)) return "automotive";
  if (/ลูกแบด|แบด|กีฬา|วิ่ง|ฟิตเนส|รองเท้า|ถุงเท้า/i.test(haystack)) return "sports";
  if (/อาหาร|ขนม|น้ำพริก|กาแฟ|ชา|เครื่องดื่ม/i.test(haystack) && !/อาหารเสริม|วิตามิน|เวย์|โปรตีน/i.test(haystack)) return "food";
  if (/สกินแคร์|เซรั่ม|กันแดด|ผิว|เครื่องสำอาง|เวชสำอาง/i.test(haystack)) return "beauty";
  if (/สร้อย|สร้อยคอ|เครื่องประดับ|จี้|ต่างหู|แหวน|กำไล|jewelry|necklace|earring|ring|bracelet/i.test(haystack)) return "jewelry";
  if (/กล้อง|มือถือ|หูฟัง|สมาร์ทวอทช์|แกดเจ็ต|ลำโพง/i.test(haystack)) return "electronics";
  if (/ครัว|แก้ว|กระติก|ขวดน้ำ|ถาดน้ำแข็ง|หม้อ|กระทะ/i.test(haystack)) return "kitchen";
  if (/กระเป๋า|เดินทาง|แคมป์|เที่ยว/i.test(haystack)) return "travel";
  if (/ทำความสะอาด|ไม้ถู|ชั้นวาง|กล่องเก็บ|จัดระเบียบ|ของใช้ในบ้าน/i.test(haystack)) return "home";
  return "generic_product";
}

function buildEntitySpecificStoryboardPreset(input: {
  storyboard: Omit<
    ShopeeProductStoryboard,
    "problemSolved" | "dailyBenefit" | "emotionalBenefit" | "realUsageScenario" | "purchaseReason" | "primaryPainPoint"
  >;
  productLabel: string;
  mainUseCase: string;
  usageScene: string;
}) {
  const target = input.storyboard.targetUser || `คนที่กำลังมองหา${input.productLabel}`;
  const keySellingPoint = input.storyboard.keySellingPoint || `ช่วยให้${input.mainUseCase}ได้ตรงกับการใช้งานจริง`;
  return {
    primaryPainPoint: `กำลังมองหา${input.productLabel}ที่ใช้กับ${input.mainUseCase}ได้จริง`,
    problemSolved: keySellingPoint,
    dailyBenefit: input.mainUseCase,
    emotionalBenefit: `ใช้${input.productLabel}ได้ตรงกับจุดประสงค์มากขึ้น`,
    purchaseReason: `เหมาะกับ${target}ที่อยากได้${input.productLabel}สำหรับ${input.mainUseCase}`
  };
}

function enrichShopeeStoryboardForAffiliateReview(
  storyboard: Omit<
    ShopeeProductStoryboard,
    "problemSolved" | "dailyBenefit" | "emotionalBenefit" | "realUsageScenario" | "purchaseReason" | "primaryPainPoint"
  >
): ShopeeProductStoryboard {
  const group = getShopeeStoryboardProductGroup(storyboard);
  const productLabel = storyboard.productEntity || storyboard.productType || "สินค้า";
  const mainUseCase = storyboard.mainUseCase || `ใช้งาน${productLabel}ตามจุดเด่นของสินค้า`;
  const usageScene = storyboard.usageScene || mainUseCase;
  const templates: Record<string, Pick<ShopeeProductStoryboard, "primaryPainPoint" | "problemSolved" | "dailyBenefit" | "emotionalBenefit" | "purchaseReason">> = {
    water_filter: {
      primaryPainPoint: "อยากมีน้ำดื่มสะอาดไว้กดใช้ที่บ้าน",
      problemSolved: "ช่วยให้กดน้ำดื่มใช้ได้สะดวกโดยไม่ต้องซื้อน้ำขวดบ่อย",
      dailyBenefit: "กดน้ำดื่มไว้ใช้ในบ้านหรือคอนโดได้สะดวก",
      emotionalBenefit: "มีน้ำดื่มพร้อมใช้แล้วรู้สึกสบายใจกว่าเดิม",
      purchaseReason: "เหมาะกับบ้านหรือคอนโดที่อยากมีน้ำดื่มสะอาดไว้ใช้ทุกวัน"
    },
    apparel: {
      primaryPainPoint: `กำลังหา${productLabel}ที่ใส่ง่ายและแมตช์ได้หลายโอกาส`,
      problemSolved: "ช่วยให้แต่งตัวง่ายขึ้นด้วยทรง ดีไซน์ และเนื้อผ้าที่เข้ากับลุคจริง",
      dailyBenefit: "ใส่ไปทำงาน ไปเที่ยว หรือวันลำลองได้ง่าย",
      emotionalBenefit: "แต่งตัวแล้วลุคดูลงตัวและมั่นใจขึ้น",
      purchaseReason: `เหมาะกับคนที่อยากได้${productLabel}ใส่ง่าย แมตช์ง่าย และใช้ได้หลายโอกาส`
    },
    drinkware: {
      primaryPainPoint: "อยากพกน้ำหรือเครื่องดื่มไว้จิบระหว่างวัน",
      problemSolved: "ช่วยให้พกน้ำไปทำงาน เดินทาง หรือออกกำลังกายได้สะดวกขึ้น",
      dailyBenefit: "พกน้ำหรือเครื่องดื่มไว้ใช้ที่โต๊ะทำงาน ระหว่างเดินทาง หรือฟิตเนส",
      emotionalBenefit: "มีน้ำติดตัวแล้วจิบระหว่างวันได้สบายขึ้น",
      purchaseReason: `เหมาะกับคนที่อยากได้${productLabel}ไว้พกน้ำหรือเครื่องดื่มติดตัว`
    },
    dashcam: {
      primaryPainPoint: "ขับรถแล้วอยากมีหลักฐานเวลาเกิดเหตุ",
      problemSolved: "ช่วยบันทึกเหตุการณ์ระหว่างขับขี่ไว้ดูย้อนหลังได้",
      dailyBenefit: "ติดหน้ารถไว้บันทึกเส้นทางและเหตุการณ์บนถนน",
      emotionalBenefit: "ขับรถแล้วอุ่นใจกว่าเดิมเพราะมีหลักฐานติดไว้",
      purchaseReason: "เหมาะกับคนใช้รถทุกวันหรือเดินทางบ่อย"
    },
    automotive: {
      primaryPainPoint: "รถมีปัญหากลางทางแล้วไม่มีตัวช่วย",
      problemSolved: "ช่วยรับมือเหตุฉุกเฉินเกี่ยวกับรถได้สะดวกขึ้น",
      dailyBenefit: "เก็บไว้ในรถสำหรับช่วงเดินทางหรือจอดรถไว้นาน",
      emotionalBenefit: "มีติดรถไว้แล้วอุ่นใจกว่าเดิม",
      purchaseReason: "คุ้มสำหรับคนที่อยากมีตัวช่วยฉุกเฉินติดรถไว้"
    },
    sports: {
      primaryPainPoint: "ซ้อมหรือออกกำลังกายแล้วอุปกรณ์ไม่พร้อม",
      problemSolved: "ช่วยให้การซ้อมและการเคลื่อนไหวคล่องตัวขึ้น",
      dailyBenefit: "ใช้กับการออกกำลังกายหรือเล่นกีฬาได้เป็นประจำ",
      emotionalBenefit: "รู้สึกพร้อมขึ้นเวลาซ้อมหรือทำกิจกรรม",
      purchaseReason: "เหมาะกับคนที่เล่นกีฬาหรือออกกำลังกายบ่อย"
    },
    food: {
      primaryPainPoint: "อยากมีของกินติดบ้านที่แบ่งกินได้สะดวก",
      problemSolved: "ช่วยให้มีของกินพร้อมแบ่งหรือใช้คู่กับมื้ออาหาร",
      dailyBenefit: "เก็บไว้ในครัวหรือโต๊ะอาหารเพื่อแบ่งกินตามมื้อ",
      emotionalBenefit: "มีติดบ้านไว้แล้วสะดวกกว่าเวลาอยากกิน",
      purchaseReason: "น่าลองสำหรับคนที่อยากมีของกินติดบ้าน"
    },
    beauty: {
      primaryPainPoint: "อยากได้สกินแคร์ที่ใช้แล้วไม่หนักหน้า",
      problemSolved: /กันแดด|sunscreen|spf/i.test(getShopeeStoryboardEntityText(storyboard))
        ? "ใช้ก่อนออกแดดหรือก่อนแต่งหน้าได้ เหมาะกับวันที่ต้องเจอแดดหรืออยู่ห้องแอร์"
        : "เนื้อบางเบา ซึมไว ใช้ก่อนแต่งหน้าแล้วผิวดูชุ่มชื้นขึ้น",
      dailyBenefit: /กันแดด|sunscreen|spf/i.test(getShopeeStoryboardEntityText(storyboard))
        ? "ทาช่วงเช้าก่อนออกจากบ้านหรือก่อนแต่งหน้า"
        : "ทาหลังล้างหน้า ก่อนลงครีมหรือก่อนแต่งหน้า",
      emotionalBenefit: "ผิวดูพร้อมขึ้นในวันที่ต้องออกไปข้างนอก",
      purchaseReason: "เหมาะกับคนที่อยากได้สกินแคร์ใช้จริงทุกวัน ไม่เหนอะหนะหน้า"
    },
    jewelry: {
      primaryPainPoint: "แต่งตัวเรียบ ๆ แล้วอยากให้ลุคดูมีอะไรขึ้น",
      problemSolved: "ช่วยเพิ่มดีเทลให้ลุคดูเรียบหรูขึ้นโดยไม่ต้องแต่งเยอะ",
      dailyBenefit: "ใส่คู่กับเสื้อผ้าเรียบ ๆ แล้วช่วยให้ลุคดูครบขึ้น",
      emotionalBenefit: "เพิ่มความมั่นใจเวลาแต่งตัวออกไปข้างนอก",
      purchaseReason: "เหมาะกับคนที่ชอบเครื่องประดับโทนเรียบหรูและแมตช์ง่าย"
    },
    electronics: {
      primaryPainPoint: "อยากใช้งานหรือทำคอนเทนต์ให้สะดวกขึ้น",
      problemSolved: "ช่วยให้ใช้งานกับมือถือ เดินทาง หรือทำคอนเทนต์ได้ง่าย",
      dailyBenefit: "พกใช้กับมือถือ งาน หรือการเดินทางระหว่างวันได้สะดวก",
      emotionalBenefit: "ทำให้กิจกรรมประจำวันสนุกและคล่องตัวขึ้น",
      purchaseReason: "คุ้มสำหรับคนที่ใช้งานจริงและอยากได้ตัวช่วยที่พกง่าย"
    },
    kitchen: {
      primaryPainPoint: "มุมครัวหรือเครื่องดื่มระหว่างวันยังไม่สะดวก",
      problemSolved: "ช่วยให้การเตรียมของในครัวหรือพกเครื่องดื่มง่ายขึ้น",
      dailyBenefit: "ใช้ตอนทำอาหาร จัดเก็บ หรือเตรียมเครื่องดื่มได้สะดวก",
      emotionalBenefit: "ทำให้การเตรียมอาหารหรือจัดครัวเป็นระบบขึ้น",
      purchaseReason: "ของมันต้องมีสำหรับบ้านที่ใช้งานครัวหรือพกเครื่องดื่มบ่อย"
    },
    travel: {
      primaryPainPoint: "ออกไปข้างนอกแล้วของจุกจิกจัดการยาก",
      problemSolved: "ช่วยให้พกของหรือใช้งานระหว่างเดินทางคล่องตัวขึ้น",
      dailyBenefit: "ใช้ตอนเดินทาง ทำงาน หรือออกนอกบ้านได้สะดวก",
      emotionalBenefit: "พกไว้แล้วรู้สึกพร้อมกว่าเดิม",
      purchaseReason: "เหมาะกับคนที่เดินทางหรือพกของออกจากบ้านบ่อย"
    },
  };
  const preset = templates[group] ?? buildEntitySpecificStoryboardPreset({
    storyboard,
    productLabel,
    mainUseCase,
    usageScene
  });
  const enriched = {
    ...storyboard,
    primaryPainPoint: compactProductText(preset.primaryPainPoint, 110),
    problemSolved: compactProductText(storyboard.keySellingPoint || preset.problemSolved, 110),
    dailyBenefit: compactProductText(mainUseCase || preset.dailyBenefit, 90),
    emotionalBenefit: compactProductText(preset.emotionalBenefit, 90),
    realUsageScenario: compactProductText(usageScene || preset.dailyBenefit, 90),
    purchaseReason: compactProductText(preset.purchaseReason, 110)
  };
  return {
    ...enriched,
    primaryPainPoint: sanitizeShopeeStoryboardTextForEntity(enriched.primaryPainPoint, enriched),
    problemSolved: sanitizeShopeeStoryboardTextForEntity(enriched.problemSolved, enriched),
    dailyBenefit: sanitizeShopeeStoryboardTextForEntity(enriched.dailyBenefit, enriched),
    emotionalBenefit: sanitizeShopeeStoryboardTextForEntity(enriched.emotionalBenefit, enriched),
    realUsageScenario: sanitizeShopeeStoryboardTextForEntity(enriched.realUsageScenario, enriched),
    purchaseReason: sanitizeShopeeStoryboardTextForEntity(enriched.purchaseReason, enriched)
  };
}

const SHOPEE_STORYBOARD_RULES: ShopeeStoryboardRule[] = [
  {
    pattern: /เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|coway|โคเวย์|water\s?(?:purifier|filter)/i,
    build: (product) => {
      const entity = extractShopeeProductEntity(product);
      return makeShopeeStoryboard({
        ...product,
        productName: entity.cleanedTitle || product.productName
      }, {
        productType: entity.productType,
        whatItIs: entity.whatItIs,
        mainUseCase: entity.mainUseCase,
        targetUser: entity.targetUser,
        keySellingPoint: entity.keySellingPoint,
        usageScene: entity.realUsageScenario,
        captionAngle: entity.captionAngle
      });
    }
  },
  {
    pattern: /เสื้อ|shirt|t-?shirt|tee|blouse|polo|กระโปรง|skirt|เดรส|dress|กางเกง|pants|แฟชั่น|fashion/i,
    build: (product) => {
      const entity = extractShopeeProductEntity(product);
      return makeShopeeStoryboard({
        ...product,
        productName: entity.cleanedTitle || product.productName
      }, {
        productType: entity.productType,
        whatItIs: entity.whatItIs,
        mainUseCase: entity.mainUseCase,
        targetUser: entity.targetUser,
        keySellingPoint: entity.keySellingPoint,
        usageScene: entity.realUsageScenario,
        captionAngle: entity.captionAngle
      });
    }
  },
  {
    pattern: /ลูกแบด|shuttlecock|badminton|แบดมินตัน/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "ลูกแบดมินตัน",
      whatItIs: "ลูกแบดสำหรับซ้อมหรือเล่นแบดมินตัน",
      mainUseCase: "ใช้ซ้อมตีแบดหรือเล่นแบดมินตัน",
      targetUser: "คนเล่นแบดมินตันหรือซ้อมตีแบดบ่อย",
      keySellingPoint: "หยิบใช้ซ้อมได้สะดวกและเข้ากับการเล่นแบด",
      usageScene: "สนามแบดหรือช่วงซ้อมตีแบด",
      captionAngle: "เปิดหลอดแล้วหยิบใช้ซ้อมตีแบดได้สะดวก เหมาะกับคนที่เล่นหรือซ้อมเป็นประจำ"
    })
  },
  {
    pattern: /insta360|action\s?cam|กล้องแอคชั่?น|360\s?(?:องศา|degree)?|camera/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: /insta360/i.test(product.productName) ? "กล้องแอคชั่น Insta360" : "กล้องแอคชั่น",
      whatItIs: "กล้องแอคชั่นสำหรับถ่ายวิดีโอและมุมมองกว้าง",
      mainUseCase: "ถ่ายกิจกรรม เดินทาง หรือคอนเทนต์มุมมองกว้าง",
      targetUser: "คนทำคอนเทนต์ เดินทาง หรือชอบถ่ายกิจกรรม",
      keySellingPoint: "พกง่ายและช่วยเก็บมุมภาพที่กล้องทั่วไปทำได้ยาก",
      usageScene: "ทริปเดินทาง โต๊ะทำงาน หรือกิจกรรมกลางแจ้ง",
      captionAngle: "พกไปถ่ายตอนเดินทางหรือทำคอนเทนต์ได้สะดวก เก็บมุมกว้างได้โดยไม่ต้องตั้งอุปกรณ์เยอะ"
    })
  },
  {
    pattern: /อาหารเสริม|supplement|วิตามิน|vitamin|เวย์|whey|protein|โปรตีน|dr\.?pong|ผลิตภัณฑ์สุขภาพ/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /เวย์|whey|protein|โปรตีน/i.test(haystack) ? "เวย์โปรตีน" : /วิตามิน|vitamin|dr\.?pong/i.test(haystack) ? "วิตามิน / อาหารเสริม" : "ผลิตภัณฑ์ดูแลสุขภาพ",
      whatItIs: "ผลิตภัณฑ์เสริมสำหรับดูแลสุขภาพตามความต้องการ",
      mainUseCase: /เวย์|protein|โปรตีน/i.test(haystack) ? "เสริมโปรตีนในวันที่ออกกำลังกายหรือจัดโภชนาการ" : "ใช้เสริมการดูแลสุขภาพประจำวันตามคำแนะนำบนสินค้า",
      targetUser: /เวย์|protein|โปรตีน/i.test(haystack) ? "คนออกกำลังกายหรืออยากเสริมโปรตีน" : "คนที่มองหาอาหารเสริมหรือวิตามินไว้ดูแลตัวเอง",
      keySellingPoint: "รูปแบบพกพาและหยิบใช้ตาม routine ได้ง่าย",
      usageScene: /เวย์|protein|โปรตีน/i.test(haystack) ? "หลังออกกำลังกายหรือช่วงจัดมื้อโปรตีน" : "วางไว้หยิบทานตาม routine ดูแลสุขภาพ",
      captionAngle: /เวย์|protein|โปรตีน/i.test(haystack)
        ? "ชงดื่มเสริมโปรตีนหลังออกกำลังกายได้สะดวก เหมาะกับคนที่จัดโภชนาการเป็นประจำ"
        : "วางไว้เป็นส่วนหนึ่งของ routine ดูแลสุขภาพได้ง่าย ขนาดพกพาหรือหยิบใช้สะดวก"
    })
  },
  {
    pattern: /เก้าอี้สำนักงาน|office\s?chair|ergonomic|เก้าอี้ทำงาน|เก้าอี้ออฟฟิศ/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "เก้าอี้สำนักงาน",
      whatItIs: "เก้าอี้สำหรับนั่งทำงานหรือเรียนที่โต๊ะ",
      mainUseCase: "ใช้รองรับการนั่งทำงาน อ่านหนังสือ หรือใช้งานคอมพิวเตอร์",
      targetUser: "คนทำงานหน้าคอมหรือจัดมุมทำงาน",
      keySellingPoint: "ช่วยให้มุมทำงานนั่งใช้งานได้นานขึ้นและเป็นสัดส่วน",
      usageScene: "โต๊ะทำงาน ห้องทำงาน หรือมุมอ่านหนังสือ",
      captionAngle: "เหมาะกับมุมทำงานที่ต้องนั่งนาน ๆ ช่วยให้จัดพื้นที่นั่งทำงานเป็นสัดส่วนขึ้น"
    })
  },
  {
    pattern: /รองเท้า|running\s?shoe|sneaker|adizero|adidas|nike|shoe/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /วิ่ง|running|adizero/i.test(haystack) ? "รองเท้าวิ่ง" : "รองเท้ากีฬา",
      whatItIs: "รองเท้าสำหรับเดิน วิ่ง หรือออกกำลังกาย",
      mainUseCase: "ใส่เดิน วิ่ง หรือทำกิจกรรมที่ต้องเคลื่อนไหว",
      targetUser: "คนที่วิ่ง ออกกำลังกาย หรือเดินเยอะ",
      keySellingPoint: "ช่วยให้เคลื่อนไหวได้คล่องและเข้ากับกิจกรรมกีฬา",
      usageScene: "สนามวิ่ง ฟิตเนส หรือวันที่ต้องเดินเยอะ",
      captionAngle: "ใส่เดินหรือวิ่งแล้วคล่องตัว เหมาะกับวันที่ต้องขยับตัวเยอะหรือออกกำลังกาย"
    })
  },
  {
    pattern: /ถุงเท้า|sock|yonex|quarter\s?socks?/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "ถุงเท้ากีฬา",
      whatItIs: "ถุงเท้าสำหรับเล่นกีฬาและออกกำลังกาย",
      mainUseCase: "ใส่เล่นกีฬา วิ่ง ฟิตเนส หรือเดินนาน",
      targetUser: "คนเล่นกีฬาและออกกำลังกาย",
      keySellingPoint: "ช่วยให้เท้ากระชับและลดการเสียดสีระหว่างเคลื่อนไหว",
      usageScene: "สนามกีฬา ฟิตเนส หรือช่วงออกกำลังกาย",
      captionAngle: "ใส่ออกกำลังกายแล้วกระชับเท้า เดินหรือวิ่งนาน ๆ ก็ยังรู้สึกคล่องตัว"
    })
  },
  {
    pattern: /แก้ว|tumbler|cup|กระติก|ขวดน้ำ|bottle|เก็บความเย็น|เก็บอุณหภูมิ/i,
    build: (product) => {
      const entity = extractShopeeProductEntity(product);
      return makeShopeeStoryboard({
        ...product,
        productName: entity.cleanedTitle || product.productName
      }, {
        productType: entity.productType,
        whatItIs: entity.whatItIs,
        mainUseCase: entity.mainUseCase,
        targetUser: entity.targetUser,
        keySellingPoint: entity.keySellingPoint,
        usageScene: entity.realUsageScenario,
        captionAngle: entity.captionAngle
      });
    }
  },
  {
    pattern: /โคมไฟ|lamp|desk\s?light|led\s?light|อ่านหนังสือ|ถนอมสายตา/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "โคมไฟตั้งโต๊ะ",
      whatItIs: "โคมไฟสำหรับอ่านหนังสือหรือทำงานบนโต๊ะ",
      mainUseCase: "เพิ่มแสงสว่างตอนอ่านหนังสือ ทำงาน หรือใช้คอม",
      targetUser: "คนทำงาน อ่านหนังสือ หรือจัดโต๊ะเรียน",
      keySellingPoint: "ช่วยให้มุมโต๊ะมีแสงสว่างเหมาะกับการใช้งานมากขึ้น",
      usageScene: "โต๊ะทำงาน โต๊ะอ่านหนังสือ หรือหัวเตียง",
      captionAngle: "แสงช่วยให้มุมอ่านหนังสือหรือทำงานตอนกลางคืนใช้งานได้สบายตาขึ้น"
    })
  },
  {
    pattern: /หูฟัง|earbud|earphone|headphone|bluetooth|ลำโพง|speaker/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "หูฟัง / แกดเจ็ตเสียง",
      whatItIs: "อุปกรณ์เสียงสำหรับฟังเพลง คุยสาย หรือใช้งานกับมือถือ",
      mainUseCase: "ใช้ฟังเสียงระหว่างเดินทาง ทำงาน หรือพักผ่อน",
      targetUser: "คนใช้มือถือ ฟังเพลง หรือคุยสายบ่อย",
      keySellingPoint: "พกง่ายและหยิบใช้กับมือถือได้สะดวก",
      usageScene: "ระหว่างเดินทาง โต๊ะทำงาน หรือช่วงพัก",
      captionAngle: "พกไว้ใช้กับมือถือได้ง่าย เหมาะกับช่วงเดินทางหรือทำงานที่ต้องฟังเสียงส่วนตัว"
    })
  },
  {
    pattern: /smart\s?watch|สมาร์ทวอทช์|นาฬิกาอัจฉริยะ|awei|fitness\s?tracker/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "สมาร์ทวอทช์",
      whatItIs: "นาฬิกาอัจฉริยะสำหรับดูข้อมูลและการแจ้งเตือนบนข้อมือ",
      mainUseCase: "ใส่ติดตัวเพื่อดูเวลา การแจ้งเตือน หรือข้อมูลกิจกรรม",
      targetUser: "คนที่อยากมีแกดเจ็ตติดข้อมือสำหรับใช้งานระหว่างวัน",
      keySellingPoint: "ดูข้อมูลบนข้อมือได้สะดวกโดยไม่ต้องหยิบมือถือบ่อย",
      usageScene: "ทำงาน เดินทาง หรือออกกำลังกาย",
      captionAngle: "ใส่ติดข้อมือไว้ดูเวลาและการแจ้งเตือนได้ง่าย เหมาะกับวันที่ไม่อยากหยิบมือถือบ่อย"
    })
  },
  {
    pattern: /สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|บำรุง|ผิว|cosmetic|cleanser|d'?alba/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /กันแดด|sunscreen|spf/i.test(haystack) ? "กันแดด" : /serum|เซรั่ม|d'?alba/i.test(haystack) ? "เซรั่มบำรุงผิว" : "สกินแคร์",
      whatItIs: "ผลิตภัณฑ์ดูแลผิวตามคุณสมบัติที่ระบุ",
      mainUseCase: "ใช้เป็นส่วนหนึ่งของ routine ดูแลผิว",
      targetUser: "คนที่มองหาไอเทมดูแลผิวไว้ใช้ประจำ",
      keySellingPoint: "รูปแบบใช้งานง่ายและวางไว้หยิบใช้ใน routine ได้สะดวก",
      usageScene: "หน้าโต๊ะเครื่องแป้ง ห้องน้ำ หรือก่อนออกจากบ้าน",
      captionAngle: "หยิบใช้ใน routine ดูแลผิวได้สะดวก ขนาดและรูปแบบเหมาะกับการวางไว้ใช้ประจำ"
    })
  },
  {
    pattern: /สร้อย|สร้อยคอ|necklace|จี้|pendant|เครื่องประดับ|jewelry|ต่างหู|earring|แหวน|ring|กำไล|bracelet|bangle/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /ต่างหู|earring/i.test(haystack)
        ? "ต่างหูแฟชั่น"
        : /แหวน|ring/i.test(haystack)
          ? "แหวนแฟชั่น"
          : /กำไล|bracelet|bangle/i.test(haystack)
            ? "กำไลแฟชั่น"
            : "สร้อยคอ / เครื่องประดับ",
      whatItIs: "เครื่องประดับสำหรับเพิ่มดีเทลให้ลุคแต่งตัว",
      mainUseCase: "ใส่แมตช์กับเสื้อผ้าเวลาออกไปข้างนอก ไปทำงาน ไปเที่ยว หรือถ่ายรูป",
      targetUser: "คนที่ชอบเครื่องประดับโทนเรียบหรูและอยากให้ลุคดูมีดีเทลขึ้น",
      keySellingPoint: /จี้|pendant|สร้อย|necklace/i.test(haystack)
        ? "เส้นเล็กกำลังดี ใส่แล้วช่วยให้ช่วงคอดูมีดีเทลและลุคดูเรียบหรูขึ้น"
        : "ช่วยเติมดีเทลให้ลุคโดยไม่ต้องแต่งเยอะ",
      usageScene: "ใส่คู่กับชุดทำงาน ชุดไปเที่ยว หรือวันที่อยากให้ลุคดูเรียบร้อยขึ้น",
      captionAngle: "ใส่คู่กับเสื้อเรียบ ๆ แล้วช่วยให้ลุคดูมีอะไรขึ้น เหมาะกับคนชอบเครื่องประดับสไตล์เรียบหรู"
    })
  },
  {
    pattern: /กระเป๋า|bag|เป้|คาดอก|crossbody|wallet/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /คาดอก|crossbody/i.test(haystack) ? "กระเป๋าคาดอก" : "กระเป๋าพกพา",
      whatItIs: "กระเป๋าสำหรับพกของจำเป็นเวลาออกจากบ้าน",
      mainUseCase: "ใส่ของจุกจิก โทรศัพท์ กระเป๋าสตางค์ หรือของใช้ส่วนตัว",
      targetUser: "คนที่เดินทางหรืออยากจัดของพกพาให้หยิบง่าย",
      keySellingPoint: "ช่วยรวมของจำเป็นไว้ในใบเดียวและหยิบใช้ง่าย",
      usageScene: "เดินทาง คาเฟ่ ที่ทำงาน หรือออกไปข้างนอก",
      captionAngle: "ใส่ของจำเป็นเวลาออกจากบ้านได้เป็นระเบียบ หยิบโทรศัพท์หรือกระเป๋าสตางค์ได้ง่ายขึ้น"
    })
  },
  {
    pattern: /กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|car\s?camera|drive\s?recorder|บันทึกภาพรถ|กล้องรถ|hp\s*f491|f491x|gps\s*built\s*in/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "กล้องติดรถยนต์",
      whatItIs: "กล้องสำหรับบันทึกภาพระหว่างขับขี่และเหตุการณ์บนถนน",
      mainUseCase: "ติดหน้ารถเพื่อบันทึกเส้นทาง เหตุการณ์ และหลักฐานระหว่างขับขี่",
      targetUser: "คนใช้รถที่อยากมีหลักฐานและความอุ่นใจเวลาเดินทาง",
      keySellingPoint: "ช่วยบันทึกเหตุการณ์บนถนนไว้ดูย้อนหลังเมื่อจำเป็น",
      usageScene: "หน้ารถ ระหว่างขับขี่ หรือจอดรถ",
      captionAngle: "ติดหน้ารถไว้บันทึกเหตุการณ์ระหว่างขับขี่ ดูย้อนหลังได้เวลาจำเป็นและช่วยให้ขับขี่อุ่นใจขึ้น"
    })
  },
  {
    pattern: /จัมป์สตาร์ท|jump\s?starter|แบตเตอรี่รถ|รถยนต์|automotive|ยางรถ|michelin|bosch/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /ยาง|michelin/i.test(haystack) ? "ยางรถยนต์" : "อุปกรณ์จัมป์สตาร์ทรถยนต์",
      whatItIs: /ยาง|michelin/i.test(haystack) ? "ยางสำหรับรถยนต์" : "อุปกรณ์ช่วยสตาร์ทรถเมื่อแบตเตอรี่มีปัญหา",
      mainUseCase: /ยาง|michelin/i.test(haystack) ? "ใช้เปลี่ยนยางรถเพื่อการขับขี่" : "พกไว้ช่วยแก้ปัญหาสตาร์ทรถไม่ติด",
      targetUser: "คนใช้รถยนต์",
      keySellingPoint: /ยาง|michelin/i.test(haystack) ? "เลือกให้เข้ากับรถและรูปแบบการขับขี่" : "พกไว้ในรถเพื่อความอุ่นใจเวลาเจอแบตหมด",
      usageScene: "ในรถ โรงรถ หรือเวลาเดินทาง",
      captionAngle: /ยาง|michelin/i.test(haystack)
        ? "เหมาะกับคนที่กำลังดูยางใหม่สำหรับใช้งานประจำวัน เลือกตามขนาดและรถที่ใช้อยู่ได้"
        : "พกไว้ในรถแล้วอุ่นใจกว่าเดิม เวลาเจอปัญหาสตาร์ทไม่ติดระหว่างทางจะได้มีตัวช่วย"
    })
  },
  {
    pattern: /art\s?toy|อาร์ตทอย|กล่องสุ่ม|blind\s?box|figure|ฟิกเกอร์|โมเดล|ของสะสม|collectible|ตุ๊กตา|yumi|จุ่ม/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /กล่องสุ่ม|blind\s?box|จุ่ม/i.test(haystack) ? "กล่องสุ่ม / Art Toy" : "Art Toy / ของสะสม",
      whatItIs: "ของสะสมหรือฟิกเกอร์สำหรับตั้งโชว์",
      mainUseCase: "สะสม ตั้งโชว์ หรือใช้ตกแต่งมุมโปรด",
      targetUser: "สายจุ่ม สายสะสม หรือคนชอบฟิกเกอร์น่ารัก",
      keySellingPoint: "ได้ลุ้นตัวละครและเติมมุมโชว์ให้มีคาแรกเตอร์",
      usageScene: "ชั้นวาง โต๊ะทำงาน หรือมุมสะสม",
      captionAngle: "เหมาะกับสายสะสมที่ชอบลุ้นตัวละคร งานดีเทลน่ารัก วางตั้งโชว์แล้วมุมโต๊ะดูมีคาแรกเตอร์ขึ้น"
    })
  },
  {
    pattern: /สัตว์|pet|แมว|cat|สุนัข|dog|อาหารสัตว์|ทรายแมว|ปลอกคอ/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "อุปกรณ์สัตว์เลี้ยง",
      whatItIs: "ของใช้สำหรับดูแลสัตว์เลี้ยง",
      mainUseCase: "ใช้ดูแลอาหาร ความสะอาด หรือความสะดวกของสัตว์เลี้ยง",
      targetUser: "คนเลี้ยงแมว สุนัข หรือสัตว์เลี้ยงในบ้าน",
      keySellingPoint: "ช่วยให้การดูแลสัตว์เลี้ยงในบ้านง่ายขึ้น",
      usageScene: "มุมสัตว์เลี้ยงในบ้าน",
      captionAngle: "ช่วยให้การดูแลสัตว์เลี้ยงในบ้านสะดวกขึ้น หยิบใช้กับมุมประจำของน้อง ๆ ได้ง่าย"
    })
  },
  {
    pattern: /ทำความสะอาด|ไม้ถู|ชั้นวาง|กล่องเก็บ|จัดระเบียบ/i,
    build: (product) => makeShopeeStoryboard(product, {
      productType: "ของใช้ในบ้าน",
      whatItIs: "ของใช้สำหรับดูแลบ้านหรือจัดพื้นที่ใช้งาน",
      mainUseCase: "ใช้จัดเก็บ ทำความสะอาด หรือช่วยให้บ้านเป็นระเบียบ",
      targetUser: "คนที่ดูแลบ้านหรืออยากให้มุมใช้งานสะดวกขึ้น",
      keySellingPoint: "ช่วยลดความรกและหยิบของได้เป็นที่",
      usageScene: "ห้องครัว ห้องน้ำ หรือมุมเก็บของ",
      captionAngle: "ช่วยให้มุมที่ใช้บ่อยเป็นระเบียบขึ้น หยิบของง่ายและไม่กินพื้นที่เกินไป"
    })
  },
  {
    pattern: /ครัว|kitchen|ทำอาหาร|หม้อ|กระทะ|กล่องอาหาร|ถาดน้ำแข็ง|น้ำแข็ง|ช้อน|จาน/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /ถาดน้ำแข็ง|น้ำแข็ง/i.test(haystack) ? "ถาดทำน้ำแข็ง" : "อุปกรณ์ครัว",
      whatItIs: "อุปกรณ์สำหรับใช้ในครัวหรือจัดเตรียมอาหาร",
      mainUseCase: /ถาดน้ำแข็ง|น้ำแข็ง/i.test(haystack) ? "ทำน้ำแข็งและแยกก้อนออกมาใช้" : "ช่วยเตรียมอาหาร จัดเก็บ หรือหยิบใช้ในครัว",
      targetUser: "คนทำอาหารหรือดูแลมุมครัว",
      keySellingPoint: /ถาดน้ำแข็ง|น้ำแข็ง/i.test(haystack) ? "แบ่งช่องชัดเจนและแกะก้อนน้ำแข็งออกมาใช้ได้ง่าย" : "ช่วยให้การทำครัวสะดวกและเป็นระเบียบขึ้น",
      usageScene: "ห้องครัว ตู้เย็น หรือโต๊ะเตรียมอาหาร",
      captionAngle: /ถาดน้ำแข็ง|น้ำแข็ง/i.test(haystack)
        ? "ช่องแยกเป็นสัดส่วน แกะก้อนน้ำแข็งออกมาใช้ได้ง่าย เหมาะกับมีติดตู้เย็นไว้"
        : "หยิบใช้ตอนเตรียมอาหารได้สะดวก ช่วยให้มุมครัวเป็นระเบียบขึ้น"
    })
  },
  {
    pattern: /ขนม|snack|อาหาร(?!เสริม)|food|เครื่องดื่ม|drink|กาแฟ|coffee|ชา|tea|เปี๊ยะ|คุกกี้|เค้ก|น้ำพริก/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /น้ำพริก/i.test(haystack) ? "น้ำพริก / ของกินติดบ้าน" : "ของกิน / เครื่องดื่ม",
      whatItIs: "ของกินหรือเครื่องดื่มสำหรับเก็บไว้ที่บ้าน",
      mainUseCase: "เก็บไว้กินกับมื้ออาหาร แบ่งกับคนที่บ้าน หรือพกตามโอกาส",
      targetUser: "คนที่อยากมีของกินติดบ้าน",
      keySellingPoint: "แพ็กเก็บง่ายและหยิบใช้ตามมื้ออาหารได้สะดวก",
      usageScene: "โต๊ะอาหาร ครัว หรือช่วงเตรียมมื้ออาหาร",
      captionAngle: /น้ำพริก/i.test(haystack)
        ? "แพ็กเก็บง่าย เหมาะมีติดบ้านไว้กินคู่กับมื้ออาหารหรือแบ่งกับคนในบ้าน"
        : "เก็บไว้เป็นของกินติดบ้านได้สะดวก หยิบแบ่งหรือพกออกไปได้ง่ายตามแพ็ก"
    })
  }
];

function inferShopeeFallbackProductType(product: ShopeeProductRecord, haystack: string) {
  const title = normalizeTextEncoding(product.productName || "");
  const simpleName = getShopeeCaptionProductName(title)
    .replace(/[✨🔥😍😋💯👍🎯🛒💥⭐📌📍🥤☕🧊💡🏠🏃⚽🎾🚗🍳📱💻💚💖💎👟📷⌚🎒🏸🦷🌀]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  const rules: Array<[RegExp, string]> = [
    [/เทียนหอม|scented\s?candle|aroma\s?candle|soy\s?wax|apple\s*cranberry/i, "scented_candle"],
    [/ผ้าปูโต๊ะ|table\s?cloth|tablecloth|กันน้ำ.*โต๊ะ|โต๊ะ.*กันน้ำ/i, /กันน้ำ|waterproof/i.test(haystack) ? "waterproof_tablecloth" : "tablecloth"],
    [/เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|coway|โคเวย์|water\s?(?:purifier|filter)/i, "เครื่องกรองน้ำ"],
    [/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|car\s?camera|drive\s?recorder|บันทึกภาพรถ|กล้องรถ|gps\s*built/i, "กล้องติดรถยนต์"],
    [/จัมป์สตาร์ท|jump\s?starter|แบตเตอรี่รถ|เติมลม|ยางรถ|รถยนต์|automotive/i, "อุปกรณ์รถยนต์"],
    [/insta360|action\s?cam|กล้องแอคชั่?น|กล้อง|camera/i, "กล้องพกพา"],
    [/ลูกแบด|shuttlecock|badminton|แบดมินตัน/i, "ลูกแบดมินตัน"],
    [/กระโปรง|skirt/i, "กระโปรง"],
    [/เดรส|dress/i, "เดรส"],
    [/เสื้อ|shirt|t-?shirt|tee|blouse|polo/i, "เสื้อ"],
    [/กางเกง|pants|trousers/i, /กีฬา|sport|วิ่ง|running/i.test(haystack) ? "กางเกงกีฬา" : "กางเกง"],
    [/รองเท้า|running\s?shoe|sneaker|adidas|nike|shoe/i, /วิ่ง|running/i.test(haystack) ? "รองเท้าวิ่ง" : "รองเท้ากีฬา"],
    [/ถุงเท้า|sock|yonex/i, "ถุงเท้ากีฬา"],
    [/เวย์|whey|protein|โปรตีน/i, "เวย์โปรตีน"],
    [/อาหารเสริม|supplement|วิตามิน|vitamin|ผลิตภัณฑ์สุขภาพ/i, "อาหารเสริม"],
    [/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|ผิว|cosmetic/i, "สกินแคร์"],
    [/สร้อย|สร้อยคอ|necklace|จี้|pendant|เครื่องประดับ|jewelry|ต่างหู|earring|แหวน|ring|กำไล|bracelet|bangle/i, /ต่างหู|earring/i.test(haystack) ? "ต่างหูแฟชั่น" : /แหวน|ring/i.test(haystack) ? "แหวนแฟชั่น" : /กำไล|bracelet|bangle/i.test(haystack) ? "กำไลแฟชั่น" : "สร้อยคอ / เครื่องประดับ"],
    [/แก้ว|tumbler|cup|กระติก|ขวดน้ำ|bottle|กระบอกน้ำ|เก็บความเย็น|เก็บอุณหภูมิ/i, /กระบอกน้ำ|ขวดน้ำ|bottle|กระติก/i.test(haystack) ? "กระบอกน้ำเก็บอุณหภูมิ" : "แก้วเก็บอุณหภูมิ"],
    [/ถาดน้ำแข็ง|น้ำแข็ง/i, "ถาดทำน้ำแข็ง"],
    [/ครัว|kitchen|หม้อ|กระทะ|กล่องอาหาร|ช้อน|จาน/i, "อุปกรณ์ครัว"],
    [/โคมไฟ|lamp|desk\s?light|led\s?light|อ่านหนังสือ|ถนอมสายตา/i, "โคมไฟตั้งโต๊ะ"],
    [/หูฟัง|earbud|earphone|headphone|bluetooth|ลำโพง|speaker/i, "แกดเจ็ตเสียง"],
    [/smart\s?watch|สมาร์ทวอทช์|นาฬิกาอัจฉริยะ|fitness\s?tracker/i, "สมาร์ทวอทช์"],
    [/กระเป๋า|bag|เป้|คาดอก|crossbody|wallet/i, "กระเป๋าพกพา"],
    [/art\s?toy|อาร์ตทอย|กล่องสุ่ม|blind\s?box|figure|ฟิกเกอร์|โมเดล|ของสะสม|ตุ๊กตา|จุ่ม/i, "Art Toy / ของสะสม"],
    [/สัตว์|pet|แมว|cat|สุนัข|dog|อาหารสัตว์|ทรายแมว|ปลอกคอ/i, "อุปกรณ์สัตว์เลี้ยง"],
    [/ทำความสะอาด|ไม้ถู|ชั้นวาง|กล่องเก็บ|จัดระเบียบ/i, "ของใช้ในบ้าน"],
    [/ขนม|snack|อาหาร(?!เสริม)|food|เครื่องดื่ม|drink|กาแฟ|coffee|ชา|tea|เปี๊ยะ|คุกกี้|เค้ก|น้ำพริก/i, /น้ำพริก/i.test(haystack) ? "น้ำพริก / ของกินติดบ้าน" : "ของกินติดบ้าน"]
  ];

  const matched = rules.find(([pattern]) => pattern.test(haystack));
  return compactProductText(matched?.[1] || simpleName || "ไอเทมใช้งานประจำวัน", 48);
}

function createFallbackShopeeProductStoryboard(product: ShopeeProductRecord, haystack: string): ShopeeProductStoryboard {
  const entity = extractShopeeProductEntity(product);
  const productType = entity.productType || inferShopeeFallbackProductType(product, haystack);
  const simpleName = getShopeeCaptionProductName(entity.cleanedTitle || product.productName || productType);
  const usageFromDescription = compactProductText(
    stripShopeeMarketplaceNoise(removeShopeeProductNameFromText(product.productDescription || "", product.productName)),
    90
  );
  const isJewelry = /สร้อย|เครื่องประดับ|จี้|ต่างหู|แหวน|กำไล|jewelry|necklace|earring|bracelet/i.test(productType);
  const isApparel = /เสื้อ|กระโปรง|เดรส|กางเกง|เสื้อผ้า|เครื่องแต่งกาย|แฟชั่น/i.test(productType);
  const isDrinkware = /กระบอกน้ำ|ขวดน้ำ|กระติก|แก้วเก็บ|tumbler|bottle|เก็บอุณหภูมิ|เก็บความเย็น/i.test(productType);
  const isKitchen = /ครัว|ถาดน้ำแข็ง|หม้อ|กระทะ|กล่องอาหาร|ช้อน|จาน/i.test(productType);
  const isHomeUtility = /ทำความสะอาด|ไม้ถู|ชั้นวาง|กล่องเก็บ|จัดระเบียบ|ของใช้ในบ้าน/i.test(productType);
  const mainUseCase = isJewelry
    ? "ใส่แมตช์กับชุดทำงาน ชุดไปเที่ยว หรือวันที่อยากให้ลุคดูมีดีเทลขึ้น"
    : entity.mainUseCase || usageFromDescription || (
      isApparel
        ? `ใส่${productType}ไปทำงาน ไปเที่ยว หรือวันลำลอง`
        : isDrinkware
          ? "พกน้ำหรือเครื่องดื่มไปทำงาน เดินทาง หรือออกกำลังกาย"
          : isKitchen
            ? `ใช้${productType}ตอนเตรียมอาหารหรือจัดครัว`
            : isHomeUtility
              ? `ใช้${productType}กับงานจัดบ้าน ทำความสะอาด หรือจัดเก็บ`
              : `ใช้งาน${productType}ตามจุดเด่นของสินค้า`
    );
  const targetUser = entity.targetUser || (isJewelry
    ? "คนที่ชอบเครื่องประดับและอยากเพิ่มดีเทลให้ลุคแต่งตัว"
    : isApparel
      ? "คนที่อยากได้เสื้อผ้าใส่ง่าย แมตช์ง่าย และใช้ได้หลายโอกาส"
      : isDrinkware
        ? "คนทำงาน คนเดินทาง หรือคนออกกำลังกายที่อยากพกน้ำติดตัว"
        : `คนที่กำลังมองหา${productType}ไว้ใช้งาน`);
  const usageScene = entity.realUsageScenario || (/รถ/.test(productType)
    ? "ในรถหรือระหว่างเดินทาง"
    : /กีฬา|วิ่ง|แบด|รองเท้า|ถุงเท้า/.test(productType)
      ? "ตอนออกกำลังกายหรือทำกิจกรรม"
      : isJewelry
        ? "วันที่แต่งตัวไปทำงาน ไปเที่ยว หรือถ่ายรูป"
      : isApparel
        ? "วันทำงาน วันไปเที่ยว หรือวันลำลอง"
      : isDrinkware
        ? "โต๊ะทำงาน ระหว่างเดินทาง ฟิตเนส หรือวันที่ออกไปข้างนอก"
      : /ครัว|แก้ว|กระติก|น้ำแข็ง|อาหาร|ขนม|น้ำพริก/.test(productType)
        ? "ครัว โต๊ะอาหาร หรือช่วงเตรียมเครื่องดื่ม"
        : /สกินแคร์|อาหารเสริม|วิตามิน|เวย์|โปรตีน/.test(productType)
          ? "ใน routine ดูแลตัวเอง"
          : `บริบทใช้งานจริงของ${productType}`);

  return makeShopeeStoryboard(product, {
    productType,
    whatItIs: entity.whatItIs || simpleName || productType,
    mainUseCase,
    targetUser,
    keySellingPoint: entity.keySellingPoint || (isJewelry
      ? "ช่วยเติมดีเทลให้ลุคดูเรียบหรูขึ้นโดยไม่ต้องแต่งเยอะ"
      : isApparel
        ? "ทรง ดีไซน์ และเนื้อผ้าช่วยให้แต่งตัวได้ง่ายขึ้น"
        : isDrinkware
          ? "ช่วยให้มีน้ำหรือเครื่องดื่มติดตัวไว้จิบระหว่างวันได้สะดวก"
          : isKitchen
            ? `ช่วยให้ใช้${productType}กับการเตรียมอาหารหรือจัดครัวได้สะดวกขึ้น`
            : `จุดเด่นของ${productType}ช่วยตอบโจทย์การใช้งานจริง`),
    usageScene,
    captionAngle: entity.captionAngle || (isJewelry
      ? "ใส่คู่กับเสื้อผ้าเรียบ ๆ แล้วช่วยให้ลุคดูมีอะไรขึ้น เหมาะกับคนชอบเครื่องประดับสไตล์เรียบหรู"
      : isApparel
        ? `รีวิว${productType}จากการใส่จริง เน้นทรง เนื้อผ้า ดีไซน์ และการแมตช์ลุค`
        : isDrinkware
          ? `รีวิว${productType}จากการพกน้ำ เก็บอุณหภูมิ และใช้ระหว่างทำงาน เดินทาง หรือออกกำลังกาย`
          : `เล่าประโยชน์ของ${productType}จากการใช้งานจริงของสินค้านั้นแบบสั้นและอ่านง่าย`)
  });
}

function createShopeeProductStoryboard(product: ShopeeProductRecord): ShopeeProductStoryboard | null {
  if (!hasShopeeProductName(product) || !hasShopeeProductImage(product)) return null;
  const haystack = getShopeeStoryboardInputText(product);
  const matchedRule = SHOPEE_STORYBOARD_RULES.find((rule) => rule.pattern.test(haystack));
  if (matchedRule) return matchedRule.build(product, haystack);
  return createFallbackShopeeProductStoryboard(product, haystack);
}

function validateShopeeProductStoryboard(storyboard?: ShopeeProductStoryboard | null) {
  if (!storyboard) return false;
  return Boolean(
    storyboard.productSimpleName?.trim() &&
    storyboard.productEntity?.trim() &&
    storyboard.productType?.trim() &&
    storyboard.whatItIs?.trim() &&
    storyboard.mainUseCase?.trim() &&
    storyboard.captionAngle?.trim() &&
    storyboard.problemSolved?.trim() &&
    storyboard.dailyBenefit?.trim() &&
    storyboard.emotionalBenefit?.trim() &&
    storyboard.realUsageScenario?.trim() &&
    storyboard.targetUser?.trim() &&
    storyboard.purchaseReason?.trim() &&
    storyboard.primaryPainPoint?.trim()
  );
}

function getShopeeStoryboardHashtags(product: ShopeeProductRecord, storyboard: ShopeeProductStoryboard) {
  const group = getShopeeStoryboardProductGroup(storyboard);
  const entityText = getShopeeStoryboardEntityText(storyboard);
  const productSpecificTags: Record<string, string[]> = {
    travel_pillow: ["#หมอนรองคอ", "#เดินทาง", "#TravelEssentials"],
    water_filter_accessory: ["#ไส้กรองน้ำ", "#เครื่องกรองน้ำ", "#น้ำดื่มสะอาด"],
    water_filter: ["#เครื่องกรองน้ำ", "#น้ำดื่มสะอาด", "#กดน้ำดื่ม"],
    apparel: /sport_shirt|เสื้อกีฬา|ออกกำลังกาย|กีฬา/i.test(entityText)
      ? ["#เสื้อกีฬา", "#ออกกำลังกาย", "#SportStyle"]
      : ["#เสื้อผ้า", "#แต่งตัว", "#แมตช์ลุค"],
    drinkware: ["#กระบอกน้ำ", "#พกน้ำ", "#เก็บอุณหภูมิ"],
    jewelry: ["#เครื่องประดับ", "#สร้อยคอ", "#แต่งตัว"],
    automotive: ["#อุปกรณ์รถยนต์", "#ของใช้ติดรถ", "#รถยนต์"],
    sports: ["#กีฬา", "#ออกกำลังกาย", "#สายสปอร์ต"],
    beauty: ["#สกินแคร์", "#บำรุงผิว", "#ความงาม"],
    electronics: ["#แกดเจ็ต", "#ไอที"],
    kitchen: ["#ของใช้ในครัว", "#ครัว", "#ทำอาหาร"],
    travel: ["#เดินทาง", "#พกพา"],
    food: ["#ของกิน", "#ของกินติดบ้าน"],
    health: ["#อาหารเสริม", "#ดูแลสุขภาพ", "#สุขภาพ"],
    generic_product: []
  };
  const brandTag = storyboard.brand ? normalizeHashtagToken(storyboard.brand) : "";
  const entityTags = [
    storyboard.productEntity,
    storyboard.productType.includes("_") ? "" : storyboard.productType,
    ...storyboard.mainUseCase.split(/[\/,]|หรือ|และ/u).slice(0, 2)
  ]
    .map((part) => normalizeHashtagToken(part))
    .filter((tag) => tag && !isForbiddenShopeeHashtag(tag));
  const typeTags = storyboard.productType
    .split(/[\/\s]+/u)
    .filter((part) => !part.includes("_"))
    .map((part) => normalizeHashtagToken(part))
    .filter((tag) => tag && !isForbiddenShopeeHashtag(tag));
  return Array.from(new Set([...(productSpecificTags[group] ?? []), brandTag, ...entityTags, ...typeTags, "#Shopee"]))
    .filter((tag) => tag && !isShopeeProductNameDuplicateText(tag.replace(/^#/, ""), storyboard.productSimpleName))
    .filter((tag) => isShopeeHashtagRelevantToStoryboard(tag, storyboard))
    .slice(0, SHOPEE_MAX_HASHTAGS);
}

function isShopeeHashtagRelevantToStoryboard(tag: string, storyboard: ShopeeProductStoryboard) {
  const normalizedTag = normalizeTextEncoding(tag.replace(/^#/, "")).toLowerCase();
  const entityText = normalizeTextEncoding(getShopeeStoryboardEntityText(storyboard)).toLowerCase();
  if (!normalizedTag) return false;
  if (/คนเลี้ยงแมว|แมว|สัตว์เลี้ยง|pet|cat|dog/i.test(normalizedTag)) return /สัตว์เลี้ยง|แมว|สุนัข|pet|cat|dog/i.test(entityText);
  if (/เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม/i.test(normalizedTag)) return /water_purifier|เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม/i.test(entityText);
  if (/แฟชั่น|เสื้อผ้า|แต่งตัว|แมตช์ลุค/i.test(normalizedTag)) return /เสื้อ|กระโปรง|เดรส|กางเกง|เครื่องประดับ|jewelry|แต่งตัว|แมตช์/i.test(entityText);
  if (/ของกิน|อาหาร|ขนม/i.test(normalizedTag)) return /อาหาร|ขนม|น้ำพริก|กิน|food|snack/i.test(entityText) && !/อาหารเสริม|วิตามิน|เวย์|โปรตีน/i.test(entityText);
  return true;
}

function getShopeeStoryboardBenefitEmojis(productType: string) {
  if (/travel_pillow|หมอนรองคอ|travel\s?pillow|neck\s?pillow/i.test(productType)) return ["✈️", "🚗", "💺", "✅"];
  if (/water_purifier|เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|water\s?(?:purifier|filter)|coway|โคเวย์/i.test(productType)) return ["💧", "🏠", "🥤", "✅"];
  if (/sport_shirt|เสื้อ|กระโปรง|เดรส|กางเกง|เสื้อผ้า|แฟชั่น/i.test(productType)) return ["👕", "✨", "👗", "✅"];
  if (/กระบอกน้ำ|ขวดน้ำ|กระติก|แก้วเก็บ|tumbler|bottle|เก็บอุณหภูมิ|เก็บความเย็น/i.test(productType)) return ["🥤", "💧", "🚶", "✅"];
  if (/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|บันทึกภาพรถ/i.test(productType)) return ["📹", "🛣️", "🚘", "🔎"];
  if (/รถ|จัมป์|จั๊ม|ยาง|แบต/.test(productType)) return ["🔋", "💨", "🔦", "📱"];
  if (/ลูกแบด|กีฬา|วิ่ง|รองเท้า|ถุงเท้า/.test(productType)) return ["🏃", "💪", "🎯", "🏸"];
  if (/อาหาร|ขนม|น้ำพริก/.test(productType) && !/อาหารเสริม|วิตามิน|เวย์|โปรตีน/.test(productType)) return ["🌶️", "🍽️", "😋", "🏠"];
  if (/สกินแคร์|เซรั่ม|กันแดด|ผิว/.test(productType)) return ["✨", "💖", "🌸", "💄"];
  if (/สร้อย|เครื่องประดับ|จี้|ต่างหู|แหวน|กำไล|jewelry|necklace/.test(productType)) return ["💎", "👗", "🎁", "✨"];
  if (/กล้อง|มือถือ|หูฟัง|สมาร์ทวอทช์|แกดเจ็ต/.test(productType)) return ["📱", "📸", "🚶", "🎥"];
  if (/ครัว|แก้ว|กระติก|ขวดน้ำ|ถาดน้ำแข็ง/.test(productType)) return ["🥤", "🍳", "💧", "🏠"];
  if (/กระเป๋า|เดินทาง|แคมป์|เที่ยว/.test(productType)) return ["🎒", "✈️", "🏕️", "🚶"];
  return ["✅", "✨", "👍", "📌"];
}

function formatShopeeStoryboardPriceLine(product: ShopeeProductRecord, storyboard: ShopeeProductStoryboard) {
  const price = formatShopeePrice(product);
  const productLabel = getShopeeStoryboardProductLabel(storyboard);
  const numericPrice = typeof product.discountPrice === "number" && Number.isFinite(product.discountPrice)
    ? product.discountPrice
    : product.productPrice;
  if (typeof numericPrice === "number" && Number.isFinite(numericPrice)) {
    if (/สร้อย|เครื่องประดับ|จี้|ต่างหู|แหวน|กำไล|jewelry|necklace/.test(storyboard.productType)) {
      return `${price} สำหรับคนชอบเครื่องประดับโทนเรียบหรู`;
    }
    if (numericPrice < 300) return `${price} สำหรับ${compactProductText(storyboard.mainUseCase || productLabel, 42)}`;
    if (numericPrice > 1000) return `${price} สำหรับคนที่ต้องใช้${productLabel}จริง`;
  }
  return /ใช้งานจริง|ระยะยาว|ฉุกเฉิน|เดินทาง/.test(storyboard.purchaseReason)
    ? `${price} ใช้งานได้ระยะยาว`
    : price;
}

function buildShopeeStoryboardHook(storyboard: ShopeeProductStoryboard) {
  const emoji = getShopeeStoryboardEmoji(storyboard.productType);
  const pain = compactProductText(sanitizeShopeeStoryboardTextForEntity(storyboard.primaryPainPoint || storyboard.problemSolved, storyboard), 46).replace(/[.!。]+$/u, "");
  if (/[?？]$/u.test(pain)) return `${emoji} ${pain}`;
  return `${emoji} ${pain}?`;
}

type ShopeeStoryboardEntityLike = Partial<
  Pick<
    ShopeeProductStoryboard,
    "productEntity" | "productType" | "whatItIs" | "mainUseCase" | "captionAngle" | "usageScene" | "targetUser" | "keySellingPoint"
  >
>;

function getShopeeStoryboardEntityText(storyboard: ShopeeStoryboardEntityLike) {
  return [
    storyboard.productEntity,
    storyboard.productType,
    storyboard.whatItIs,
    storyboard.mainUseCase,
    storyboard.captionAngle,
    storyboard.usageScene,
    storyboard.targetUser,
    storyboard.keySellingPoint
  ].filter(Boolean).join(" ");
}

function getShopeeStoryboardProductLabel(storyboard: ShopeeStoryboardEntityLike) {
  return compactProductText(storyboard.productEntity || storyboard.productType || storyboard.whatItIs || "สินค้า", 42);
}

function isShopeeWaterFilterStoryboard(storyboard: ShopeeStoryboardEntityLike) {
  return /water_purifier|water_filter|เครื่องกรองน้ำ|กรองน้ำ|น้ำดื่ม|water\s?(?:purifier|filter)|coway|โคเวย์/i.test([
    storyboard.productEntity,
    storyboard.productType,
    storyboard.whatItIs,
    storyboard.mainUseCase,
    storyboard.captionAngle
  ].filter(Boolean).join(" "));
}

function isShopeeApparelStoryboard(storyboard: ShopeeStoryboardEntityLike) {
  return /sport_shirt|shirt|skirt|dress|pants|เสื้อ|กระโปรง|เดรส|กางเกง|เสื้อผ้า|เครื่องแต่งกาย|แฟชั่น|ใส่แมตช์|แต่งตัว/i.test(getShopeeStoryboardEntityText(storyboard));
}

function isShopeeDrinkwareStoryboard(storyboard: ShopeeStoryboardEntityLike) {
  return /กระบอกน้ำ|ขวดน้ำ|กระติก|แก้วเก็บ|tumbler|water\s?bottle|bottle|เก็บอุณหภูมิ|เก็บความเย็น/i.test(getShopeeStoryboardEntityText(storyboard));
}

function isShopeeBeautyStoryboard(storyboard: ShopeeStoryboardEntityLike) {
  return /skincare|สกินแคร์|เซรั่ม|กันแดด|ครีม|ผิว|บำรุง|serum|sunscreen|spf|cleanser|cosmetic/i.test(getShopeeStoryboardEntityText(storyboard));
}

function isShopeeHomeUtilityStoryboard(storyboard: ShopeeStoryboardEntityLike) {
  const entityText = getShopeeStoryboardEntityText(storyboard);
  return /ของใช้ในบ้าน|ทำความสะอาด|ไม้ถู|ชั้นวาง|กล่องเก็บ|จัดระเบียบ|งานจัดบ้าน/i.test(entityText) &&
    !isShopeeWaterFilterStoryboard(storyboard) &&
    !isShopeeApparelStoryboard(storyboard) &&
    !isShopeeDrinkwareStoryboard(storyboard);
}

function getShopeeEntityActionText(storyboard: ShopeeStoryboardEntityLike) {
  if (/travel_pillow|หมอนรองคอ|รองคอระหว่างเดินทาง/i.test(getShopeeStoryboardEntityText(storyboard))) return "รองคอระหว่างเดินทาง";
  if (isShopeeWaterFilterStoryboard(storyboard)) return "กดน้ำดื่ม";
  if (isShopeeDrinkwareStoryboard(storyboard)) return "พกน้ำหรือเครื่องดื่ม";
  if (isShopeeApparelStoryboard(storyboard)) return "ใส่และแมตช์ลุค";
  if (/รถ|จัมป์|แบต|ยาง|dash\s?cam|กล้องติดรถ/i.test(getShopeeStoryboardEntityText(storyboard))) return "ใช้งานกับรถ";
  if (isShopeeBeautyStoryboard(storyboard)) return /กันแดด|sunscreen|spf/i.test(getShopeeStoryboardEntityText(storyboard))
    ? "ทาก่อนออกแดดหรือก่อนแต่งหน้า"
    : "ทาหลังล้างหน้าและก่อนแต่งหน้า";
  if (/ครัว|ถาดน้ำแข็ง|หม้อ|กระทะ|กล่องอาหาร|ช้อน|จาน/i.test(getShopeeStoryboardEntityText(storyboard))) return "ใช้เตรียมอาหารหรือจัดครัว";
  const productLabel = getShopeeStoryboardProductLabel(storyboard);
  return compactProductText(storyboard.mainUseCase || `ใช้งาน${productLabel}`, 58);
}

function getShopeeEntityContextText(storyboard: ShopeeStoryboardEntityLike) {
  if (/travel_pillow|หมอนรองคอ|รองคอระหว่างเดินทาง/i.test(getShopeeStoryboardEntityText(storyboard))) return "ในรถ บนเครื่องบิน หรือระหว่างเดินทาง";
  if (isShopeeWaterFilterStoryboard(storyboard)) return "บ้าน คอนโด หรือมุมครัวสำหรับกดน้ำดื่ม";
  if (isShopeeDrinkwareStoryboard(storyboard)) return "ที่ทำงาน ระหว่างเดินทาง หรือออกกำลังกาย";
  if (isShopeeApparelStoryboard(storyboard)) return "วันทำงาน วันไปเที่ยว หรือวันลำลอง";
  if (isShopeeBeautyStoryboard(storyboard)) return /กันแดด|sunscreen|spf/i.test(getShopeeStoryboardEntityText(storyboard))
    ? "ตอนเช้าก่อนออกจากบ้าน วันที่ต้องออกแดด หรือวันที่อยู่ห้องแอร์"
    : "หลังล้างหน้า ก่อนแต่งหน้า หรือวันที่อยากเติมความชุ่มชื้นให้ผิว";
  return compactProductText(storyboard.usageScene || storyboard.mainUseCase || `บริบทใช้งานจริงของ${getShopeeStoryboardProductLabel(storyboard)}`, 70);
}

function repairShopeeGenericCaptionPhrasesForEntity(text: string, storyboard: ShopeeStoryboardEntityLike) {
  const source = normalizeTextEncoding(text || "").trim();
  if (!source) return source;

  if (isShopeeWaterFilterStoryboard(storyboard)) {
    return source
      .replace(/ของใช้ในบ้านหรือมุมใช้งานยังไม่ลงตัว/giu, "อยากมีน้ำดื่มสะอาดไว้กดใช้ที่บ้าน")
      .replace(/ของใช้ในบ้าน/giu, "เครื่องกรองน้ำ")
      .replace(/มุมใช้งาน/giu, "มุมกดน้ำดื่ม")
      .replace(/หยิบใช้งาน/giu, "กดน้ำดื่ม")
      .replace(/หยิบใช้(?:เครื่องกรองน้ำ|สินค้า|ไอเทม|ของใช้)?/giu, "กดน้ำดื่ม")
      .replace(/ช่วงใช้งานในชีวิตประจำวัน/giu, "ช่วงกดน้ำดื่มระหว่างวัน")
      .replace(/ใช้ในชีวิตประจำวัน/giu, "กดน้ำดื่มระหว่างวัน")
      .replace(/มีตัวช่วยไว้สะดวกกว่าเดิม/giu, "มีเครื่องกรองน้ำไว้กดน้ำดื่มสะดวกขึ้น")
      .replace(/ช่วยให้บ้านน่าอยู่ขึ้น/giu, "ช่วยให้มีน้ำดื่มสะอาดพร้อมใช้")
      .replace(/เหมาะกับทุกบ้าน/giu, "เหมาะกับบ้านหรือคอนโดที่ต้องการน้ำดื่มสะอาด")
      .replace(/ช่วยให้บ้านดูใช้งานง่ายและสบายขึ้น/giu, "ช่วยให้มีน้ำดื่มพร้อมใช้ในบ้านได้สะดวกขึ้น")
      .replace(/ช่วยให้กิจวัตรในบ้านสะดวกและเป็นระเบียบขึ้น/giu, "ช่วยให้กดน้ำดื่มใช้ในบ้านได้สะดวกขึ้น")
      .replace(/น่าลองสำหรับคนที่อยากให้ชีวิตประจำวันง่ายขึ้น/giu, "เหมาะกับบ้านหรือคอนโดที่อยากมีน้ำดื่มสะอาดไว้ใช้ทุกวัน")
      .replace(/\s+/g, " ")
      .trim();
  }

  const productLabel = getShopeeStoryboardProductLabel(storyboard);
  const action = getShopeeEntityActionText(storyboard);
  const context = getShopeeEntityContextText(storyboard);
  const specificBenefit = compactProductText(storyboard.keySellingPoint || `ช่วยให้${action}ได้สะดวกขึ้น`, 90);
  const homeUtility = isShopeeHomeUtilityStoryboard(storyboard);

  return source
    .replace(/ของใช้ในบ้านหรือมุมใช้งานยังไม่ลงตัว/giu, homeUtility ? "มุมบ้านที่ต้องจัดหรือทำความสะอาดยังไม่ลงตัว" : `กำลังมองหา${productLabel}ที่ตรงกับการใช้งานจริง`)
    .replace(/ของใช้ในบ้าน/giu, homeUtility ? "สินค้าดูแลบ้าน" : productLabel)
    .replace(/มุมใช้งาน/giu, context)
    .replace(/หยิบใช้งาน/giu, action)
    .replace(/หยิบใช้(?:เครื่องกรองน้ำ|สินค้า|ไอเทม|ของใช้)?/giu, action)
    .replace(/ช่วงใช้งานในชีวิตประจำวัน/giu, context)
    .replace(/ใช้ในชีวิตประจำวัน/giu, context)
    .replace(/มีตัวช่วยไว้สะดวกกว่าเดิม/giu, specificBenefit)
    .replace(/ช่วยให้บ้านน่าอยู่ขึ้น/giu, specificBenefit)
    .replace(/เหมาะกับทุกบ้าน/giu, `เหมาะกับ${storyboard.targetUser || `คนที่กำลังมองหา${productLabel}`}`)
    .replace(/ช่วยให้บ้านดูใช้งานง่ายและสบายขึ้น/giu, specificBenefit)
    .replace(/ช่วยให้กิจวัตรในบ้านสะดวกและเป็นระเบียบขึ้น/giu, specificBenefit)
    .replace(/น่าลองสำหรับคนที่อยากให้ชีวิตประจำวันง่ายขึ้น/giu, `เหมาะกับ${storyboard.targetUser || `คนที่กำลังมองหา${productLabel}`}ที่อยากได้${productLabel}ตรงการใช้งาน`)
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeShopeeStoryboardTextForEntity(text: string, storyboard: ShopeeProductStoryboard) {
  const source = normalizeTextEncoding(text || "").trim();
  if (!source) return source;
  const normalized = repairShopeeGenericCaptionPhrasesForEntity(source, storyboard);
  return normalized || source;
}

function humanizeShopeeStoryboardCaptionLine(text: string, storyboard: ShopeeProductStoryboard) {
  const source = sanitizeShopeeStoryboardTextForEntity(text, storyboard)
    .replace(/บริบทใช้งานจริงของ/giu, "")
    .replace(/จุดเด่นของ(.+?)ช่วยตอบโจทย์การใช้งานจริง/giu, "ใช้$1ได้เข้ากับชีวิตจริง")
    .replace(/ใช้เป็นส่วนหนึ่งของ routine ดูแลผิว(?:ได้|ได้ไม่ยุ่งยาก)?/giu, "ทาหลังล้างหน้า ก่อนลงครีมหรือก่อนแต่งหน้า")
    .replace(/routine ดูแลผิว/giu, "ขั้นตอนดูแลผิว")
    .replace(/\s+/g, " ")
    .trim();
  const entityBridgeMatch = source.match(/^ใช้สำหรับ(.+)$/u);
  if (entityBridgeMatch) {
    const productLabel = getShopeeStoryboardProductLabel(storyboard);
    return `ดูรายละเอียด${productLabel}ให้ตรงกับการใช้งานที่ต้องการ`;
  }
  if (!isShopeeBeautyStoryboard(storyboard)) return source;
  if (/^สกินแคร์$/iu.test(source) || /^ดูแลผิว$/iu.test(source)) return "ทาหลังล้างหน้า ก่อนลงครีมหรือก่อนแต่งหน้า";
  if (/ขั้นตอนดูแลผิว(?:ได้)?ไม่ยุ่งยาก/iu.test(source)) return "ใช้แล้วไม่หนักหน้า เหมาะกับวันเร่ง ๆ";
  return source;
}

function dedupeCaptionBenefitLines(lines: string[]) {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = normalizeTextEncoding(line)
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/✅|✨|💖|🌸|💄|👍/gu, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildShopeeStoryboardBenefits(storyboard: ShopeeProductStoryboard) {
  const emojis = getShopeeStoryboardBenefitEmojis(storyboard.productType);
  const benefits = [
    storyboard.dailyBenefit,
    storyboard.emotionalBenefit,
    storyboard.realUsageScenario,
    storyboard.problemSolved
  ]
    .map((benefit) => compactProductText(humanizeShopeeStoryboardCaptionLine(benefit, storyboard), 62).replace(/[.!。?？]+$/u, ""))
    .filter(Boolean)
    .slice(0, 4);
  return dedupeCaptionBenefitLines(benefits).map((benefit, index) => `${emojis[index] ?? "✅"} ${benefit}`);
}

function buildShopeeStoryboardSolutionLine(storyboard: ShopeeProductStoryboard) {
  if (/travel_pillow|หมอนรองคอ|รองคอระหว่างเดินทาง/i.test(getShopeeStoryboardEntityText(storyboard))) return "รองคอระหว่างเดินทางได้สบายขึ้น ✅";
  if (isShopeeWaterFilterStoryboard(storyboard)) return "มีน้ำดื่มพร้อมกดใช้ สะดวกกว่าเดิม ✅";
  if (isShopeeDrinkwareStoryboard(storyboard)) return "พกน้ำหรือเครื่องดื่มไว้จิบระหว่างวันได้สะดวก ✅";
  if (isShopeeApparelStoryboard(storyboard)) return "ใส่แมตช์กับลุคทำงาน ไปเที่ยว หรือวันลำลองได้ง่าย ✅";
  if (isShopeeBeautyStoryboard(storyboard)) return /กันแดด|sunscreen|spf/i.test(getShopeeStoryboardEntityText(storyboard))
    ? "ทาก่อนออกแดดหรือก่อนแต่งหน้าได้ ไม่เหนอะหนะหน้า ✅"
    : "เนื้อบางเบา ซึมไว ใช้ก่อนแต่งหน้าได้สบายขึ้น ✅";
  const mainUseCase = compactProductText(humanizeShopeeStoryboardCaptionLine(storyboard.mainUseCase, storyboard), 72).replace(/[.!。?？]+$/u, "");
  if (mainUseCase) return `${mainUseCase} ✅`;
  return `${getShopeeEntityActionText(storyboard)}ได้ตรงกับการใช้งานจริง ✅`;
}

function buildShopeeStoryboardCtaLine(storyboard: ShopeeProductStoryboard) {
  const productLabel = getShopeeStoryboardProductLabel(storyboard);
  return `🛒 ดูรายละเอียด${productLabel}ได้ที่ลิงก์ด้านล่าง`;
}

function getShopeeCaptionHumanReadableLines(caption: string) {
  return normalizeTextEncoding(caption)
    .split(/\r?\n/)
    .map((line) => normalizeShopeeHumanReadableEntityText(line.trim()))
    .filter(Boolean);
}

function removeShopeeRepeatedEntitySpam(caption: string, storyboard?: ShopeeProductStoryboard) {
  if (!storyboard?.productEntity) return caption;
  const entity = normalizeShopeeHumanReadableEntityText(storyboard.productEntity);
  const comparableEntity = normalizeShopeeEntityMentionText(entity);
  if (!comparableEntity) return caption;
  let entityMentionCount = 0;
  return caption
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter((line) => {
      const comparableLine = normalizeShopeeEntityMentionText(line);
      if (!comparableLine.includes(comparableEntity)) return true;
      entityMentionCount += 1;
      if (entityMentionCount <= 2) return true;
      return !isShopeeProductNameDuplicateText(line, entity, 0.65);
    })
    .join("\n\n");
}

function humanizeShopeeCaptionBeforeValidation(caption: string, affiliateLink: string, storyboard?: ShopeeProductStoryboard) {
  const productName = storyboard?.productEntity || storyboard?.productSimpleName || "";
  let lines = getShopeeCaptionHumanReadableLines(caption);
  lines = removeDuplicateShopeeProductNameLines(lines, productName || "สินค้า");
  const seen = new Set<string>();
  const uniqueLines = lines.filter((line) => {
    const key = normalizeShopeeEntityMentionText(line);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const normalized = removeShopeeRepeatedEntitySpam(uniqueLines.join("\n\n"), storyboard)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalizeShopeeCaptionLinkLine(normalized, affiliateLink);
}

function repairStoryboardAffiliateCaption(caption: string, affiliateLink: string, storyboard?: ShopeeProductStoryboard) {
  let normalized = normalizeShopeeCaptionLinkLine(normalizeTextEncoding(caption), affiliateLink)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (storyboard) {
    const repaired = normalized
      .split(/\n{2,}/)
      .map((line) => repairShopeeGenericCaptionPhrasesForEntity(line, storyboard))
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (repaired !== normalized) {
      console.warn("[CAPTION_GENERIC_TEMPLATE_REPAIRED]", {
        productEntity: storyboard.productEntity,
        productType: storyboard.productType,
        beforePreview: normalized.slice(0, 220),
        afterPreview: repaired.slice(0, 220)
      });
      normalized = repaired;
    }
  }

  if (!/🛒|กดสั่ง|ลิงก์ด้านล่าง|ดูรายละเอียด/iu.test(normalized)) {
    normalized = `${normalized}\n\n${storyboard ? buildShopeeStoryboardCtaLine(storyboard) : "🛒 ดูรายละเอียดสินค้าได้ที่ลิงก์ด้านล่าง"}`;
  }
  if (!normalized.includes(affiliateLink)) {
    normalized = `${normalized}\n\n${formatShopeeShortLinkLine(affiliateLink)}`;
  }
  return humanizeShopeeCaptionBeforeValidation(normalized, affiliateLink, storyboard)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type StoryboardCaptionFailedRule = {
  rule: string;
  message: string;
  failedLine?: string;
  expected?: string;
  actual?: string;
};

const SHOPEE_GENERIC_CAPTION_TEMPLATE_PATTERN =
  /ของใช้ในบ้าน|หยิบใช้|ช่วยให้บ้านดูใช้งานง่าย|ช่วงใช้งานในชีวิตประจำวัน|ช่วยให้บ้านน่าอยู่ขึ้น|ใช้ในชีวิตประจำวัน|มีตัวช่วยไว้สะดวกกว่าเดิม|เหมาะกับทุกบ้าน/iu;
const SHOPEE_METADATA_CAPTION_PATTERN =
  /บริบทใช้งานจริงของ|จุดเด่นของ.+?ช่วยตอบโจทย์|usageContext|mainUseCase|productEntity|targetAudience|productType|realUsageScenario|dailyBenefit|keySellingPoint/iu;
const SHOPEE_HUMAN_READABILITY_METADATA_PATTERN =
  /รายละเอียดสินค้า|รายละเอียด[^\n]*|ข้อมูลสินค้า|บริบทใช้งาน|mainUseCase|targetAudience|productEntity|productType/iu;

function normalizeShopeeEntityMentionText(value?: string) {
  return normalizeTextEncoding(value ?? "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function hasShopeeCaptionEntityOrUseCaseMention(line: string, storyboard: ShopeeProductStoryboard) {
  const normalizedLine = normalizeShopeeEntityMentionText(line);
  const entityTokens = [
    storyboard.productEntity,
    storyboard.whatItIs,
    ...storyboard.productEntity.split(/\s+/u),
    ...storyboard.mainUseCase.split(/\s+|หรือ|และ/u)
  ]
    .map((token) => normalizeShopeeEntityMentionText(token))
    .filter((token) => token.length >= 3 && !/^(?:ใช้|หรือ|และ|สำหรับ|ระหว่าง|สินค้า|ไอเทม)$/u.test(token));
  return entityTokens.some((token) => normalizedLine.includes(token));
}

function isShopeeGenericCaptionPhraseCompatibleWithEntity(line: string, storyboard: ShopeeProductStoryboard) {
  const normalizedLine = normalizeTextEncoding(line);
  const mentionsEntity = hasShopeeCaptionEntityOrUseCaseMention(line, storyboard);
  if (/ช่วยให้บ้านดูใช้งานง่าย|ช่วยให้บ้านน่าอยู่ขึ้น|เหมาะกับทุกบ้าน/iu.test(normalizedLine)) {
    return isShopeeHomeUtilityStoryboard(storyboard) && mentionsEntity;
  }
  if (/ช่วงใช้งานในชีวิตประจำวัน|ใช้ในชีวิตประจำวัน|มีตัวช่วยไว้สะดวกกว่าเดิม/iu.test(normalizedLine)) {
    return mentionsEntity;
  }
  if (/ของใช้ในบ้าน/iu.test(normalizedLine)) {
    return isShopeeHomeUtilityStoryboard(storyboard) && mentionsEntity && /จัดบ้าน|ทำความสะอาด|จัดเก็บ|ชั้นวาง|กล่องเก็บ|ไม้ถู|มุมบ้าน/iu.test(normalizedLine);
  }
  if (/หยิบใช้/iu.test(normalizedLine)) {
    return mentionsEntity && (isShopeeHomeUtilityStoryboard(storyboard) ? /จัดเก็บ|ทำความสะอาด|ชั้นวาง|กล่องเก็บ|ไม้ถู/iu.test(normalizedLine) : true);
  }
  return true;
}

function getShopeeGenericCaptionTemplateViolation(caption: string, storyboard: ShopeeProductStoryboard) {
  const lines = caption.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failedLine = lines.find((line) =>
    SHOPEE_GENERIC_CAPTION_TEMPLATE_PATTERN.test(line) &&
    !isShopeeGenericCaptionPhraseCompatibleWithEntity(line, storyboard)
  );
  if (!failedLine) return null;
  const phrase = failedLine.match(SHOPEE_GENERIC_CAPTION_TEMPLATE_PATTERN)?.[0] ?? "";
  return { failedLine, phrase };
}

function countShopeeEntityMentions(caption: string, productEntity: string) {
  const entity = normalizeShopeeEntityMentionText(normalizeShopeeHumanReadableEntityText(productEntity));
  const text = normalizeShopeeEntityMentionText(caption);
  if (!entity || entity.length < 3 || !text.includes(entity)) return 0;
  return text.split(entity).length - 1;
}

function getShopeeCaptionHumanReadabilityIssues(caption: string, storyboard: ShopeeProductStoryboard) {
  const issues: string[] = [];
  const normalized = normalizeTextEncoding(caption);
  const cleanedEntity = normalizeShopeeHumanReadableEntityText(storyboard.productEntity || storyboard.productSimpleName);
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (/\([^)]*$/u.test(normalized)) issues.push("broken_parenthesis");
  if (/\[[^\]]*$/u.test(normalized)) issues.push("broken_square_bracket");
  if (/\{[^}]*$/u.test(normalized)) issues.push("broken_curly_bracket");
  if (/[([{&/-]\s*$/u.test(cleanedEntity) || /(?:\.{3}|…)\s*$/u.test(cleanedEntity)) issues.push("product_entity_dangling_suffix");

  const entityMentionCount = countShopeeEntityMentions(normalized, cleanedEntity);
  if (entityMentionCount > 2) issues.push("repeated_product_entity");

  const metadataLine = lines.find((line) => SHOPEE_HUMAN_READABILITY_METADATA_PATTERN.test(line));
  if (metadataLine) issues.push("metadata_fragment");

  const shortLine = lines.find((line) => {
    const comparable = normalizeTextEncoding(line)
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .trim();
    return comparable.length > 0 && comparable.length < 5;
  });
  if (shortLine) issues.push("too_short_line");

  const unfinishedLine = lines.find((line) =>
    /\([^)]*$/u.test(line) ||
    /\[[^\]]*$/u.test(line) ||
    /\{[^}]*$/u.test(line) ||
    /[([{&/-]\s*$/u.test(line) ||
    /(?:\.{3}|…)\s*$/u.test(line)
  );
  if (unfinishedLine) issues.push("unfinished_text");

  return [...new Set(issues)];
}

function getStoryboardCaptionDebugPayload(input: {
  jobId?: string;
  product: ShopeeProductRecord;
  storyboard: ShopeeProductStoryboard;
  affiliateLink: string;
  caption: string;
  validatorName?: string;
}) {
  return {
    jobId: input.jobId ?? "",
    productId: input.product.productId,
    productName: input.product.productName,
    shortLink: input.affiliateLink,
    storyboard: {
      productSimpleName: input.storyboard.productSimpleName,
      productEntity: input.storyboard.productEntity,
      brand: input.storyboard.brand ?? "",
      model: input.storyboard.model ?? "",
      productType: input.storyboard.productType,
      whatItIs: input.storyboard.whatItIs,
      mainUseCase: input.storyboard.mainUseCase,
      captionAngle: input.storyboard.captionAngle,
      primaryPainPoint: input.storyboard.primaryPainPoint,
      problemSolved: input.storyboard.problemSolved,
      dailyBenefit: input.storyboard.dailyBenefit,
      emotionalBenefit: input.storyboard.emotionalBenefit,
      realUsageScenario: input.storyboard.realUsageScenario,
      targetUser: input.storyboard.targetUser,
      purchaseReason: input.storyboard.purchaseReason
    },
    generatedCaption: input.caption,
    captionPreview: input.caption.slice(0, 500),
    validatorName: input.validatorName ?? "validateStoryboardAffiliateCaption",
    validationRulesEnabled: [
      "NON_EMPTY",
      "HAS_CTA",
      "HAS_SHOPEE_SHORT_LINK",
      "MIN_20_CHARS",
      "FACEBOOK_LENGTH_LIMIT",
      "HAS_PRICE_WHEN_PRICE_EXISTS",
      "NO_FORBIDDEN_SOURCE_LANGUAGE",
      "NO_GENERIC_CATEGORY_TEMPLATE",
      "CAPTION_HUMAN_READABILITY",
      "ENTITY_SPECIFIC_LANGUAGE",
      "STORYBOARD_REQUIRED"
    ],
    validationRulesDisabled: DISABLED_STORYBOARD_PRESENTATION_VALIDATION_RULES
  };
}

function createCaptionReadabilityValidationError(input: {
  product: ShopeeProductRecord;
  storyboard: ShopeeProductStoryboard;
  caption: string;
  detectedIssues: string[];
}) {
  const detail = {
    productId: input.product.productId,
    productEntity: input.storyboard.productEntity,
    captionPreview: input.caption.slice(0, 500),
    detectedIssues: input.detectedIssues
  };
  console.warn("[CAPTION_READABILITY_FAILED]", detail);
  return new ShopeeProviderError(
    `CAPTION_READABILITY_FAILED for ${input.product.productId}: ${input.detectedIssues.join(", ")}`,
    422,
    "caption_readability_failed",
    "internal_api",
    JSON.stringify(detail)
  );
}

function createStoryboardCaptionValidationError(input: {
  product: ShopeeProductRecord;
  storyboard: ShopeeProductStoryboard;
  affiliateLink: string;
  caption: string;
  normalized: string;
  failedRules: StoryboardCaptionFailedRule[];
  jobId?: string;
}) {
  const failedRuleNames = input.failedRules.map((rule) => rule.rule);
  const detail = {
    ...getStoryboardCaptionDebugPayload({
      jobId: input.jobId,
      product: input.product,
      storyboard: input.storyboard,
      affiliateLink: input.affiliateLink,
      caption: input.normalized
    }),
    failedRules: failedRuleNames,
    failedRuleMessages: input.failedRules.map((rule) => rule.message),
    failedLine: input.failedRules.find((rule) => rule.failedLine)?.failedLine ?? "",
    expected: input.failedRules.find((rule) => rule.expected)?.expected ?? "",
    actual: input.failedRules.find((rule) => rule.actual)?.actual ?? ""
  };
  console.warn("[CAPTION_VALIDATION_FAILED_DETAIL]", detail);
  return new ShopeeProviderError(
    `storyboard caption validation failed: ${failedRuleNames.join(", ")}`,
    422,
    "storyboard_caption_validation_failed",
    "internal_api",
    JSON.stringify(detail)
  );
}

function validateStoryboardAffiliateCaption(caption: string, storyboard: ShopeeProductStoryboard, product: ShopeeProductRecord, affiliateLink: string, jobId?: string) {
  const normalized = repairStoryboardAffiliateCaption(caption, affiliateLink, storyboard);
  const failedRules: StoryboardCaptionFailedRule[] = [];
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const forbidden = /จากรูปสินค้า|จากภาพสินค้า|จากชื่อสินค้า|จากข้อมูลสินค้า|จากข้อมูลที่ระบุ|เห็นได้จากภาพ|ใช้งานได้จากชื่อสินค้า|เหมาะสำหรับจากชื่อสินค้า|จากรายละเอียดสินค้า|จากสเปกสินค้า|ตามข้อมูลสินค้า|ตามภาพสินค้า|ตามข้อมูล|ตามภาพ/iu;
  const waterFilterGenericForbidden = /ของใช้ในบ้านหรือมุมใช้งาน|มุมใช้งานยังไม่ลงตัว|หยิบใช้เครื่องกรองน้ำ|ช่วงใช้งานในชีวิตประจำวัน|ช่วยให้บ้านดูใช้งานง่าย|ช่วยให้หยิบใช้เครื่องกรองน้ำ/iu;
  if (!storyboardValidationDisabledRulesLogged) {
    console.info("[STORYBOARD_VALIDATION_RULES_DISABLED]", DISABLED_STORYBOARD_PRESENTATION_VALIDATION_RULES);
    storyboardValidationDisabledRulesLogged = true;
  }
  console.info("[CAPTION_DEBUG_BEFORE_VALIDATION]", getStoryboardCaptionDebugPayload({
    jobId,
    product,
    storyboard,
    affiliateLink,
    caption: normalized
  }));

  const readabilityIssues = getShopeeCaptionHumanReadabilityIssues(normalized, storyboard);
  if (readabilityIssues.length) {
    throw createCaptionReadabilityValidationError({
      product,
      storyboard,
      caption: normalized,
      detectedIssues: readabilityIssues
    });
  }

  if (!normalized) {
    failedRules.push({
      rule: "NON_EMPTY",
      message: "Caption is empty",
      expected: "caption has text",
      actual: "empty caption"
    });
  }
  if (normalized.length > 0 && normalized.length < 20) {
    failedRules.push({
      rule: "MIN_20_CHARS",
      message: "Caption is too short",
      expected: "caption length greater than 20 characters",
      actual: `${normalized.length} characters`
    });
  }
  if (normalized.length >= 63000) {
    failedRules.push({
      rule: "FACEBOOK_LENGTH_LIMIT",
      message: "Caption exceeds Facebook post length limit",
      expected: "caption length below Facebook limit",
      actual: `${normalized.length} characters`
    });
  }
  if (forbidden.test(normalized)) {
    const failedLine = lines.find((line) => forbidden.test(line)) ?? "";
    failedRules.push({
      rule: "NO_FORBIDDEN_SOURCE_LANGUAGE",
      message: "Caption contains forbidden legacy/source language",
      failedLine,
      expected: "review talks about the product directly",
      actual: failedLine
    });
  }
  if (isShopeeWaterFilterStoryboard(storyboard) && waterFilterGenericForbidden.test(normalized)) {
    const failedLine = lines.find((line) => waterFilterGenericForbidden.test(line)) ?? "";
    failedRules.push({
      rule: "WATER_FILTER_NO_GENERIC_USAGE",
      message: "Water filter caption still contains generic home/item phrasing",
      failedLine,
      expected: "caption talks about drinking water, pressing water, home/condo/kitchen use",
      actual: failedLine
    });
  }
  const genericTemplateViolation = getShopeeGenericCaptionTemplateViolation(normalized, storyboard);
  if (genericTemplateViolation) {
    failedRules.push({
      rule: "NO_GENERIC_CATEGORY_TEMPLATE",
      message: "Caption contains a broad category/template phrase that does not match the product entity",
      failedLine: genericTemplateViolation.failedLine,
      expected: `caption uses productEntity/productType/mainUseCase for ${storyboard.productEntity || storyboard.productType}`,
      actual: genericTemplateViolation.phrase
    });
  }
  if (SHOPEE_METADATA_CAPTION_PATTERN.test(normalized)) {
    const failedLine = lines.find((line) => SHOPEE_METADATA_CAPTION_PATTERN.test(line)) ?? "";
    failedRules.push({
      rule: "NO_METADATA_LANGUAGE",
      message: "Caption contains metadata-style wording instead of seller language",
      failedLine,
      expected: "caption uses natural seller phrases such as texture, use moment, benefit, and audience fit",
      actual: failedLine
    });
  }
  const entitySpecificLine = lines.find((line) => hasShopeeCaptionEntityOrUseCaseMention(line, storyboard));
  if (!entitySpecificLine) {
    failedRules.push({
      rule: "ENTITY_SPECIFIC_LANGUAGE",
      message: "Caption does not mention the actual product entity or main use case",
      expected: `caption references ${storyboard.productEntity} or ${storyboard.mainUseCase}`,
      actual: "no productEntity/mainUseCase mention found"
    });
  }
  const bulletCount = (normalized.match(/^(?:🔋|💨|🔦|📱|🏃|💪|🎯|🏸|🌶️|🍽️|😋|🏠|✨|💖|🌸|💄|📸|🚶|🎥|🥤|🍳|💧|🎒|✈️|🏕️|🧹|👕|👗|👍|✅)\s/gmu) || []).length;
  if (!/🛒|กดสั่ง|ลิงก์ด้านล่าง|ดูรายละเอียด/iu.test(normalized)) {
    failedRules.push({
      rule: "HAS_CTA",
      message: "Caption is missing CTA",
      expected: "CTA line such as 🛒 กดสั่งได้ที่ลิงก์ด้านล่าง",
      actual: "CTA not found"
    });
  }
  if (!normalized.includes(affiliateLink)) {
    failedRules.push({
      rule: "HAS_SHOPEE_SHORT_LINK",
      message: "Caption is missing Shopee short link",
      expected: affiliateLink,
      actual: "short link not found in caption"
    });
  }
  if (typeof product.discountPrice === "number" || typeof product.productPrice === "number") {
    if (!/ราคาโปร|บาท|฿/u.test(normalized)) {
      failedRules.push({
        rule: "HAS_PRICE_WHEN_PRICE_EXISTS",
        message: "Caption is missing price line",
        expected: "price line with ราคาโปร/บาท",
        actual: "price line not found"
      });
    }
  }
  if (!validateShopeeProductStoryboard(storyboard)) {
    failedRules.push({
      rule: "STORYBOARD_REQUIRED",
      message: "Storyboard is missing required fields",
      expected: "complete Product Storyboard",
      actual: JSON.stringify(storyboard)
    });
  }

  if (failedRules.length > 0) {
    throw createStoryboardCaptionValidationError({
      product,
      storyboard,
      affiliateLink,
      caption,
      normalized,
      failedRules,
      jobId
    });
  }
  console.info("[CAPTION_VALIDATION_PASSED]", {
    jobId: jobId ?? "",
    productId: product.productId,
    validatorName: "validateStoryboardAffiliateCaption",
    captionLength: normalized.length,
    bulletCount
  });
  console.info("[CAPTION_ACCEPTED_FROM_STORYBOARD]", {
    jobId: jobId ?? "",
    productId: product.productId,
    productName: product.productName,
    storyboardType: storyboard.productType,
    benefitCount: bulletCount,
    captionLength: normalized.length
  });
  return normalized;
}

function buildShopeeStoryboardCaption(input: {
  product: ShopeeProductRecord;
  storyboard: ShopeeProductStoryboard;
  affiliateLink: string;
  jobId?: string;
}) {
  const { product, storyboard, affiliateLink } = input;
  const captionInputJson = {
    jobId: input.jobId ?? "",
    productId: product.productId,
    productName: product.productName,
    productEntity: storyboard.productEntity,
    productType: storyboard.productType,
    mainUseCase: storyboard.mainUseCase,
    targetAudience: storyboard.targetUser,
    problemSolved: storyboard.problemSolved,
    dailyBenefit: storyboard.dailyBenefit,
    emotionalBenefit: storyboard.emotionalBenefit,
    realUsageScenario: storyboard.realUsageScenario,
    purchaseReason: storyboard.purchaseReason
  };
  console.info("[CAPTION_INPUT_JSON]", captionInputJson);
  console.info("[CAPTION_PROMPT]", {
    jobId: input.jobId ?? "",
    productId: product.productId,
    composer: "buildShopeeStoryboardCaption",
    source: "deterministic_storyboard_builder",
    instruction: "Compose Thai seller-style caption from productEntity, productType, mainUseCase, and human benefit lines. Do not render metadata field names or labels such as usageContext/mainUseCase/productEntity/targetAudience."
  });
  const benefits = buildShopeeStoryboardBenefits(storyboard);
  const solutionLine = buildShopeeStoryboardSolutionLine(storyboard);
  const caption = [
    buildShopeeStoryboardHook(storyboard),
    "",
    solutionLine,
    "",
    ...benefits,
    "",
    compactProductText(`${sanitizeShopeeStoryboardTextForEntity(storyboard.purchaseReason, storyboard)} 👍`, 80),
    "",
    formatShopeeStoryboardPriceLine(product, storyboard),
    "",
    buildShopeeStoryboardCtaLine(storyboard),
    "",
    formatShopeeShortLinkLine(affiliateLink),
    "",
    getShopeeStoryboardHashtags(product, storyboard).join(" ")
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  console.info("[CAPTION_RAW_OUTPUT]", {
    jobId: input.jobId ?? "",
    productId: product.productId,
    composer: "buildShopeeStoryboardCaption",
    captionPreview: caption.slice(0, 700),
    benefitLines: benefits
  });
  const normalizedCaption = validateStoryboardAffiliateCaption(normalizeShopeeCaptionLinkLine(caption, affiliateLink), storyboard, product, affiliateLink, input.jobId);
  console.info("[CAPTION_POST_PROCESS]", {
    jobId: input.jobId ?? "",
    productId: product.productId,
    composer: "repairStoryboardAffiliateCaption + validateStoryboardAffiliateCaption",
    captionPreview: normalizedCaption.slice(0, 700),
    changed: normalizedCaption !== caption
  });
  return assertValidTextEncoding(
    normalizedCaption,
    "Shopee storyboard caption"
  );
}

function createValidatedShopeeProductStoryboard(product: ShopeeProductRecord) {
  const understanding = extractShopeeProductUnderstanding(product);
  assertValidShopeeProductUnderstanding(understanding, product);
  let storyboard = createShopeeProductStoryboard(product);
  if (validateShopeeProductStoryboard(storyboard)) {
    console.info("[PRODUCT_STORYBOARD_CREATED]", {
      productId: product.productId,
      productName: product.productName,
      productType: storyboard?.productType,
      source: "rule"
    });
    return storyboard as ShopeeProductStoryboard;
  }

  console.warn("[PRODUCT_STORYBOARD_REGENERATED]", {
    productId: product.productId,
    productName: product.productName,
    reason: "missing required storyboard fields"
  });
  storyboard = createShopeeProductStoryboard(product);
  if (validateShopeeProductStoryboard(storyboard)) {
    console.info("[PRODUCT_STORYBOARD_CREATED]", {
      productId: product.productId,
      productName: product.productName,
      productType: storyboard?.productType,
      source: "storyboard_retry"
    });
    return storyboard as ShopeeProductStoryboard;
  }

  console.warn("[PRODUCT_STORYBOARD_FAILED]", {
    productId: product.productId,
    productName: product.productName,
    hasName: hasShopeeProductName(product),
    hasImage: hasShopeeProductImage(product)
  });
  throw new ShopeeProviderError(
    `PRODUCT_STORYBOARD_FAILED for ${product.productId}`,
    422,
    "storyboard_generation_failed",
    "internal_api"
  );
}

function getShopeeStoryboardProvider() {
  return process.env.OPENAI_STORYBOARD_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "rule_storyboard";
}

function getShopeeStoryboardPromptLength(product: ShopeeProductRecord) {
  return [
    product.productName,
    product.productDescription,
    product.category,
    product.productUrl,
    product.productImageUrl,
    ...(product.productImageUrls ?? [])
  ].filter(Boolean).join("\n").length;
}

function isStoryboardTimeoutError(error: unknown) {
  if (error instanceof ShopeeProviderError && error.code === "storyboard_timeout") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("storyboard request timeout");
}

function withStoryboardTimeout<T>(producer: () => T | Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    Promise.resolve().then(producer),
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => {
        reject(
          new ShopeeProviderError(
            `Storyboard request timeout after ${timeoutMs}ms`,
            504,
            "storyboard_timeout",
            "internal_api"
          )
        );
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function createShopeeProductStoryboardWithTracing(input: {
  userId: string;
  jobId?: string;
  product: ShopeeProductRecord;
  attempt: number;
}) {
  const provider = getShopeeStoryboardProvider();
  const startedAt = new Date();
  const requestId = crypto.randomUUID();
  const promptLength = getShopeeStoryboardPromptLength(input.product);
  const baseMetadata = {
    requestId,
    attempt: input.attempt,
    retryCount: Math.max(0, input.attempt - 1),
    maxAttempts: STORYBOARD_MAX_ATTEMPTS,
    provider,
    timeoutMs: STORYBOARD_TIMEOUT_MS,
    startedAt: startedAt.toISOString(),
    promptLength
  };

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    step: "OPENAI_STORYBOARD_REQUEST_START",
    status: "started",
    message: "Storyboard request started",
    metadata: baseMetadata
  });

  try {
    const storyboard = await withStoryboardTimeout(
      () => createValidatedShopeeProductStoryboard(input.product),
      STORYBOARD_TIMEOUT_MS
    );
    const completedAt = new Date();
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "OPENAI_STORYBOARD_REQUEST_END",
      status: "success",
      message: "Storyboard request completed",
      metadata: {
        ...baseMetadata,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        productType: storyboard.productType,
        mainUseCase: storyboard.mainUseCase
      }
    });
    return storyboard;
  } catch (error) {
    const completedAt = new Date();
    const timeout = isStoryboardTimeoutError(error);
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: timeout ? "OPENAI_STORYBOARD_REQUEST_TIMEOUT" : "OPENAI_STORYBOARD_REQUEST_FAILED",
      status: "failed",
      message: timeout ? "Storyboard request timed out" : "Storyboard request failed",
      metadata: {
        ...baseMetadata,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime()
      },
      error
    });
    if (timeout) {
      await logShopeePackageStage({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        step: "STORYBOARD_TIMEOUT",
        status: "failed",
        message: `Product Storyboard timed out after ${STORYBOARD_TIMEOUT_MS}ms`,
        metadata: {
          jobId: input.jobId,
          productId: input.product.productId,
          productName: input.product.productName,
          provider,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          promptLength,
          attempt: input.attempt,
          retryCount: Math.max(0, input.attempt - 1),
          maxAttempts: STORYBOARD_MAX_ATTEMPTS
        },
        error
      });
    }
    throw error;
  }
}

async function createShopeeProductStoryboardWithRetry(input: {
  userId: string;
  jobId?: string;
  product: ShopeeProductRecord;
}) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= STORYBOARD_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await logShopeePackageStage({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        step: "STORYBOARD_RETRYING",
        status: "started",
        message: `Retrying Product Storyboard generation (${attempt}/${STORYBOARD_MAX_ATTEMPTS})`,
        metadata: {
          attempt,
          retryCount: attempt - 1,
          maxAttempts: STORYBOARD_MAX_ATTEMPTS,
          provider: getShopeeStoryboardProvider()
        }
      });
    }

    try {
      return await createShopeeProductStoryboardWithTracing({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        attempt
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw new ShopeeProviderError(
    `PRODUCT_STORYBOARD_FAILED after retry: ${lastError instanceof Error ? lastError.message : "Storyboard did not return a valid result"}`,
    422,
    "storyboard_generation_failed",
    "internal_api"
  );
}

export async function createOrReuseAffiliateShortLink(input: {
  userId: string;
  product: ShopeeProductRecord;
  trackingId?: string;
  pageId?: string;
}) {
  const trackingId = input.trackingId?.trim() || process.env.SHOPEE_TRACKING_ID?.trim() || "default";
  const originalUrl = input.product.productUrl || `https://shopee.co.th/product/${input.product.shopId}/${input.product.itemId}`;
  const affiliateUrl = buildAffiliateLink(input.product, trackingId);

  if (!affiliateUrl) {
    throw new ShopeeProviderError("Affiliate link generation failed", 500, "shopee_affiliate_link_failed", "config");
  }
  if (!isShopeeShortLink(affiliateUrl)) {
    const validationReason = getShopeeShortLinkValidationReason(affiliateUrl);
    const apiResponse = {
      source: "buildAffiliateLink",
      productId: input.product.productId,
      shopId: input.product.shopId,
      itemId: input.product.itemId,
      originalUrl,
      affiliateLink: affiliateUrl,
      shortLink: affiliateUrl,
      validation: {
        expectedPrefix: "https://s.shopee.co.th/",
        reason: validationReason,
        hasShortCode: false
      }
    };
    const responseSummary = JSON.stringify(apiResponse);

    await logShopeeAutomationEvent({
      userId: input.userId,
      level: "error",
      message: "Short link generation failed",
      pageId: input.pageId,
      productId: input.product.productId,
      metadata: {
        productId: input.product.productId,
        shopId: input.product.shopId,
        itemId: input.product.itemId,
        productName: input.product.productName,
        affiliateLink: affiliateUrl,
        shortLink: affiliateUrl,
        apiResponse,
        errorReason: validationReason,
        trackingId
      }
    });

    throw new ShopeeProviderError(
      `Shopee short link validation failed. Expected https://s.shopee.co.th/{shortCode}, got ${getSafeHostname(affiliateUrl)}`,
      422,
      "shopee_short_link_invalid",
      "config",
      responseSummary
    );
  }

  const doc = await AffiliateLink.findOneAndUpdate(
    {
      userId: input.userId,
      productId: input.product.productId,
      trackingId
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
      status: "active",
      lastError: null,
      metadataJson: {
        source: "shopee-affiliate",
        shopName: input.product.shopName ?? "",
        category: input.product.category,
        pageId: input.pageId ?? "",
        trackingId,
        shortUrl: affiliateUrl
      }
    },
    { upsert: true, new: true }
  );

  await logShopeeAutomationEvent({
    userId: input.userId,
    level: "info",
    message: "Short link generated successfully",
    pageId: input.pageId,
    productId: input.product.productId,
    metadata: {
      productId: input.product.productId,
      shopId: input.product.shopId,
      itemId: input.product.itemId,
      affiliateLink: affiliateUrl,
      shortLink: affiliateUrl,
      apiResponse: {
        source: "buildAffiliateLink",
        status: "valid_short_link",
        expectedPrefix: "https://s.shopee.co.th/"
      },
      trackingId,
      shortUrl: affiliateUrl
    }
  });

  return {
    trackingId,
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
    reason.push("ยอดขายสูงมาก");
  } else if (sales >= 3000) {
    score += 12;
    reason.push("ยอดขายดี");
  } else if (sales > 0) {
    score += 6;
    reason.push("มีสัญญาณยอดขาย");
  }

  const rating = product.rating ?? 0;
  if (rating >= 4.8) {
    score += 14;
    reason.push("เรตติ้งดีมาก");
  } else if (rating >= 4.5) {
    score += 10;
    reason.push("เรตติ้งดี");
  } else if (rating > 0 && rating < 4.2) {
    score -= 10;
    riskFlags.push("rating_low");
  }

  const discount = product.discountPercent ?? 0;
  if (discount >= 45) {
    score += 14;
    reason.push("ส่วนลดเด่น");
  } else if (discount >= 20) {
    score += 8;
    reason.push("มีส่วนลดน่าสนใจ");
  }

  const commission = product.commissionRate ?? 0;
  if (commission >= 8) {
    score += 10;
    reason.push("คอมมิชชันดี");
  } else if (commission >= 5) {
    score += 6;
    reason.push("คอมมิชชันใช้ได้");
  }

  if (product.sourceTag === "trending" || product.sourceTag === "best_selling") {
    score += 10;
    reason.push(product.sourceTag === "trending" ? "สินค้าอยู่ในกระแส" : "สินค้า best-selling");
  }

  const reviews = product.reviewCount ?? 0;
  if (reviews >= 1000) {
    score += 8;
    reason.push("มีรีวิวจำนวนมาก");
  } else if (reviews >= 100) {
    score += 4;
    reason.push("มีรีวิวช่วยประกอบการตัดสินใจ");
  }

  if (input.categoryPriority?.some((category) => isShopeeCategoryMatch(product.category, category))) {
    score += 7;
    reason.push("ตรงหมวดหมู่ที่ตั้งค่าไว้");
  }

  if (input.blockedCategories?.some((category) => isShopeeCategoryMatch(product.category, category))) {
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
    reason: reason.length ? reason : ["สินค้าอยู่ในเกณฑ์พื้นฐาน"],
    riskFlags
  };
}

type ShopeeSourceScoreInput = {
  product: ShopeeProductRecord;
  sourceTag: ShopeeSourceTag;
  keyword?: string;
  categories?: string[];
};

type ShopeeSourceScoreResult = {
  score: ProductScore;
  sourceSpecificScore: number;
  scoreBreakdown: Record<string, unknown>;
  sortPrimary: number;
  sortSecondary: number;
  sortTertiary: number;
  topCandidateLimit: number;
};

type ShopeeSourceScoredCandidate = {
  product: ShopeeProductRecord;
  score: ProductScore;
  sourceSpecificScore: number;
  scoreBreakdown: Record<string, unknown>;
  sortPrimary: number;
  sortSecondary: number;
  sortTertiary: number;
  topCandidateLimit: number;
  finalRank?: number;
};

const SHOPEE_MIN_SOURCE_SPECIFIC_SCORE = 35;

function toFiniteNumber(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, value));
}

function roundScore(value: number) {
  return Math.round(clampScore(value));
}

function roundMetric(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeCountScore(value: unknown, max = 20000) {
  const count = Math.max(0, toFiniteNumber(value));
  if (count <= 0) return 0;
  return clampScore((Math.log10(count + 1) / Math.log10(max + 1)) * 100);
}

function normalizeLinearScore(value: unknown, max: number) {
  return clampScore(clamp01(Math.max(0, toFiniteNumber(value)) / max) * 100);
}

function getEffectiveProductPrice(product: ShopeeProductRecord) {
  const discountPrice = toFiniteNumber(product.discountPrice);
  if (discountPrice > 0) return discountPrice;
  return Math.max(0, toFiniteNumber(product.productPrice));
}

function getShopeeProductFreshnessScore(product: ShopeeProductRecord) {
  const createdAt = product.productCreatedAt ? new Date(product.productCreatedAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return { freshnessScore: 50, freshnessSource: "neutral_no_product_created_at" };
  }
  const ageDays = Math.max(0, (Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) return { freshnessScore: 100, freshnessSource: "product_created_at", ageDays: roundMetric(ageDays, 1) };
  if (ageDays <= 30) return { freshnessScore: 85, freshnessSource: "product_created_at", ageDays: roundMetric(ageDays, 1) };
  if (ageDays <= 90) return { freshnessScore: 65, freshnessSource: "product_created_at", ageDays: roundMetric(ageDays, 1) };
  if (ageDays <= 180) return { freshnessScore: 40, freshnessSource: "product_created_at", ageDays: roundMetric(ageDays, 1) };
  return { freshnessScore: 20, freshnessSource: "product_created_at", ageDays: roundMetric(ageDays, 1) };
}

function getShopeeProductQualityScore(product: ShopeeProductRecord) {
  const price = getEffectiveProductPrice(product);
  const priceScore = price > 0 ? (price <= 100000 ? 100 : 55) : 0;
  const imageScore = product.productImageUrl || product.productImageUrls?.length ? 100 : 0;
  const linkScore = product.productUrl || product.affiliateUrl ? 100 : 0;
  const stock = product.stock;
  const availabilityScore = stock === undefined || stock === null ? 70 : toFiniteNumber(stock) > 0 ? 100 : 0;
  const ratingScore = normalizeLinearScore(product.rating, 5);
  return roundMetric((priceScore * 0.25) + (imageScore * 0.2) + (linkScore * 0.2) + (availabilityScore * 0.2) + (ratingScore * 0.15));
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeSearchText(value?: string) {
  return normalizeSearchText(value ?? "")
    .split(/[\s,./|(){}\[\]:"'!?;+-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function getKeywordMatchScores(product: ShopeeProductRecord, keyword?: string) {
  const normalizedKeyword = normalizeSearchText(keyword ?? "");
  const title = normalizeSearchText(product.productName);
  const haystack = normalizeSearchText(`${product.productName} ${product.productDescription} ${product.category}`);
  if (!normalizedKeyword) {
    return { exactKeywordMatchScore: 0, partialKeywordMatchScore: 0, keywordMatchScore: 0 };
  }
  const exactKeywordMatchScore = title.includes(normalizedKeyword) ? 100 : 0;
  const tokens = tokenizeSearchText(normalizedKeyword);
  const matchedTokens = tokens.filter((token) => haystack.includes(token)).length;
  const partialKeywordMatchScore = tokens.length ? (matchedTokens / tokens.length) * 100 : exactKeywordMatchScore;
  return {
    exactKeywordMatchScore,
    partialKeywordMatchScore: roundMetric(partialKeywordMatchScore),
    keywordMatchScore: roundMetric(Math.max(exactKeywordMatchScore, partialKeywordMatchScore * 0.85))
  };
}

function getSearchDemandKeyword(input: ShopeeSourceScoreInput) {
  const keyword = input.keyword?.trim();
  if (keyword) return keyword;
  const categoryTerms = (input.categories ?? []).flatMap((category) => getShopeeCategorySearchTerms(category));
  return categoryTerms[0] ?? "";
}

function getDemandWordScore(product: ShopeeProductRecord) {
  const haystack = normalizeSearchText(`${product.productName} ${product.productDescription}`);
  const demandWords = ["ยอดนิยม", "ขายดี", "ฮิต", "มาแรง", "ไวรัล", "รีวิวเยอะ", "best seller", "bestseller", "trend", "viral"];
  return demandWords.some((word) => haystack.includes(word)) ? 100 : 0;
}

function getCategoryMatchScore(product: ShopeeProductRecord, categories?: string[]) {
  return categories?.some((category) => isShopeeCategoryMatch(product.category, category)) ? 100 : 0;
}

function buildSourceProductScore(input: {
  product: ShopeeProductRecord;
  sourceTag: ShopeeSourceTag;
  score: number;
  reason: string;
  breakdown: Record<string, unknown>;
}): ProductScore {
  const riskFlags: string[] = [];
  if ((input.product.rating ?? 0) > 0 && (input.product.rating ?? 0) < 4.2) riskFlags.push("rating_low");
  if (!input.product.productImageUrl && !input.product.productImageUrls?.length) riskFlags.push("missing_image");
  if (!input.product.productUrl && !input.product.affiliateUrl) riskFlags.push("missing_product_url");
  if (input.product.stock !== undefined && input.product.stock !== null && toFiniteNumber(input.product.stock) <= 0) riskFlags.push("out_of_stock");
  return {
    productScore: roundScore(input.score),
    sourceSpecificScore: roundScore(input.score),
    source: input.sourceTag,
    reason: [input.reason],
    riskFlags,
    scoreBreakdown: input.breakdown
  };
}

export function scoreShopeeProductForSource(input: ShopeeSourceScoreInput): ShopeeSourceScoreResult {
  const { product, sourceTag } = input;
  const sales = Math.max(0, toFiniteNumber(product.salesCount));
  const rating = Math.max(0, toFiniteNumber(product.rating));
  const reviewCount = Math.max(0, toFiniteNumber(product.reviewCount));
  const discount = Math.max(0, toFiniteNumber(product.discountPercent));
  const commissionRate = Math.max(0, toFiniteNumber(product.commissionRate));
  const price = getEffectiveProductPrice(product);
  const salesScore = normalizeCountScore(sales, 20000);
  const ratingScore = normalizeLinearScore(rating, 5);
  const reviewScore = normalizeCountScore(reviewCount, 5000);
  const discountScore = normalizeLinearScore(discount, 60);
  const commissionRateScore = normalizeLinearScore(commissionRate, 20);
  const productQualityScore = getShopeeProductQualityScore(product);
  const sourceApiBonus = product.sourceApiSignal ? 100 : 0;
  const baseBreakdown = {
    salesScore: roundMetric(salesScore),
    ratingScore: roundMetric(ratingScore),
    reviewScore: roundMetric(reviewScore),
    discountScore: roundMetric(discountScore),
    commissionRateScore: roundMetric(commissionRateScore),
    productQualityScore,
    sourceApiBonus,
    sourceApiSignal: Boolean(product.sourceApiSignal)
  };

  if (sourceTag === "best_selling") {
    const bestSellingScore =
      (salesScore * 0.6) +
      (reviewScore * 0.2) +
      (ratingScore * 0.15) +
      (productQualityScore * 0.05);
    const breakdown = {
      ...baseBreakdown,
      formula: "salesScore*0.60 + reviewScore*0.20 + ratingScore*0.15 + productQualityScore*0.05"
    };
    return {
      sourceSpecificScore: roundScore(bestSellingScore),
      scoreBreakdown: breakdown,
      sortPrimary: sales,
      sortSecondary: bestSellingScore,
      sortTertiary: reviewCount,
      topCandidateLimit: 5,
      score: buildSourceProductScore({
        product,
        sourceTag,
        score: bestSellingScore,
        reason: "best_selling_score prioritizes real sales count",
        breakdown
      })
    };
  }

  if (sourceTag === "top_search") {
    const searchVolume = Math.max(0, toFiniteNumber(product.searchVolume));
    const demandKeyword = getSearchDemandKeyword(input);
    const keywordScores = getKeywordMatchScores(product, demandKeyword);
    const demandWordScore = getDemandWordScore(product);
    const searchVolumeScore = normalizeCountScore(searchVolume, 100000);
    const keywordMatchScore = searchVolume > 0
      ? keywordScores.keywordMatchScore
      : Math.max(keywordScores.keywordMatchScore, demandWordScore);
    const searchDemandScore = searchVolume > 0
      ? (searchVolumeScore * 0.55) +
        (keywordMatchScore * 0.15) +
        (salesScore * 0.1) +
        (reviewScore * 0.1) +
        (ratingScore * 0.05) +
        (sourceApiBonus * 0.05)
      : (keywordMatchScore * 0.35) +
        (salesScore * 0.25) +
        (reviewScore * 0.15) +
        (ratingScore * 0.1) +
        (sourceApiBonus * 0.15);
    const searchSignalMode = searchVolume > 0
      ? "search_volume"
      : demandKeyword
        ? "keyword_relevance_fallback_no_search_volume"
        : "shopee_suggested_no_search_volume";
    const breakdown = {
      ...baseBreakdown,
      searchVolume,
      searchVolumeScore: roundMetric(searchVolumeScore),
      demandKeyword,
      demandWordScore,
      exactKeywordMatchScore: keywordScores.exactKeywordMatchScore,
      partialKeywordMatchScore: keywordScores.partialKeywordMatchScore,
      keywordMatchScore: roundMetric(keywordMatchScore),
      searchSignalMode,
      formula: searchVolume > 0
        ? "searchVolumeScore*0.55 + keywordMatchScore*0.15 + salesScore*0.10 + reviewScore*0.10 + ratingScore*0.05 + sourceApiBonus*0.05"
        : "keywordMatchScore*0.35 + salesScore*0.25 + reviewScore*0.15 + ratingScore*0.10 + sourceApiBonus*0.15"
    };
    return {
      sourceSpecificScore: roundScore(searchDemandScore),
      scoreBreakdown: breakdown,
      sortPrimary: searchDemandScore,
      sortSecondary: searchVolume || sales,
      sortTertiary: reviewCount,
      topCandidateLimit: 10,
      score: buildSourceProductScore({
        product,
        sourceTag,
        score: searchDemandScore,
        reason: searchVolume > 0
          ? "top_search_score uses Shopee searchVolume"
          : "top_search_score uses keyword demand fallback because searchVolume is unavailable",
        breakdown
      })
    };
  }

  if (sourceTag === "best_roi") {
    const estimatedCommission = price * (commissionRate / 100);
    const estimatedCommissionScore = normalizeLinearScore(estimatedCommission, 500);
    const conversionProxy =
      (salesScore * 0.4) +
      (ratingScore * 0.25) +
      (reviewScore * 0.2) +
      (discountScore * 0.15);
    const roiScore =
      (estimatedCommissionScore * 0.45) +
      (conversionProxy * 0.45) +
      (productQualityScore * 0.1);
    const breakdown = {
      ...baseBreakdown,
      price,
      estimatedCommission: roundMetric(estimatedCommission),
      estimatedCommissionScore: roundMetric(estimatedCommissionScore),
      conversionProxy: roundMetric(conversionProxy),
      formula: "estimatedCommissionScore*0.45 + conversionProxy*0.45 + productQualityScore*0.10"
    };
    return {
      sourceSpecificScore: roundScore(roiScore),
      scoreBreakdown: breakdown,
      sortPrimary: roiScore,
      sortSecondary: estimatedCommission,
      sortTertiary: sales,
      topCandidateLimit: 5,
      score: buildSourceProductScore({
        product,
        sourceTag,
        score: roiScore,
        reason: "best_roi_score estimates affiliate commission potential",
        breakdown
      })
    };
  }

  if (sourceTag === "manual") {
    const keywordScores = getKeywordMatchScores(product, input.keyword);
    const categoryMatchScore = getCategoryMatchScore(product, input.categories);
    const manualScore =
      (keywordScores.exactKeywordMatchScore * 0.4) +
      (keywordScores.partialKeywordMatchScore * 0.2) +
      (categoryMatchScore * 0.1) +
      (salesScore * 0.15) +
      (ratingScore * 0.1) +
      (commissionRateScore * 0.05);
    const breakdown = {
      ...baseBreakdown,
      keyword: input.keyword?.trim() ?? "",
      exactKeywordMatchScore: keywordScores.exactKeywordMatchScore,
      partialKeywordMatchScore: keywordScores.partialKeywordMatchScore,
      categoryMatchScore,
      formula: "exactKeywordMatch*0.40 + partialKeywordMatch*0.20 + categoryMatch*0.10 + salesScore*0.15 + ratingScore*0.10 + commissionScore*0.05"
    };
    return {
      sourceSpecificScore: roundScore(manualScore),
      scoreBreakdown: breakdown,
      sortPrimary: manualScore,
      sortSecondary: keywordScores.exactKeywordMatchScore || keywordScores.partialKeywordMatchScore,
      sortTertiary: sales,
      topCandidateLimit: 10,
      score: buildSourceProductScore({
        product,
        sourceTag,
        score: manualScore,
        reason: "manual_score prioritizes user keyword relevance",
        breakdown
      })
    };
  }

  const velocityValue = Math.max(0, toFiniteNumber(product.salesVelocity || product.recentSales));
  const velocityScore = velocityValue > 0 ? normalizeCountScore(velocityValue, 5000) : undefined;
  const salesMomentumScore = velocityScore ?? salesScore;
  const freshness = getShopeeProductFreshnessScore(product);
  const trendingScore =
    (salesMomentumScore * 0.35) +
    (discountScore * 0.2) +
    (ratingScore * 0.15) +
    (reviewScore * 0.1) +
    (freshness.freshnessScore * 0.1) +
    (sourceApiBonus * 0.1);
  const breakdown = {
    ...baseBreakdown,
    recentSales: product.recentSales ?? null,
    salesVelocity: product.salesVelocity ?? null,
    salesVelocityAvailable: velocityScore !== undefined,
    salesMomentumScore: roundMetric(salesMomentumScore),
    freshnessScore: freshness.freshnessScore,
    freshnessSource: freshness.freshnessSource,
    ageDays: "ageDays" in freshness ? freshness.ageDays : null,
    formula: "salesMomentumScore*0.35 + discountScore*0.20 + ratingScore*0.15 + reviewScore*0.10 + freshnessScore*0.10 + sourceApiBonus*0.10"
  };
  return {
    sourceSpecificScore: roundScore(trendingScore),
    scoreBreakdown: breakdown,
    sortPrimary: trendingScore,
    sortSecondary: velocityValue || sales,
    sortTertiary: discount,
    topCandidateLimit: 10,
    score: buildSourceProductScore({
      product,
      sourceTag,
      score: trendingScore,
      reason: velocityScore !== undefined
        ? "trending_score uses recent sales velocity"
        : "trending_score uses sales, discount, rating fallback",
      breakdown
    })
  };
}

function sourceSpecificRankedSelection(candidates: ShopeeSourceScoredCandidate[], sourceTag: ShopeeSourceTag) {
  return [...candidates]
    .sort((left, right) => {
      if (sourceTag === "best_selling") {
        return (
          right.sortPrimary - left.sortPrimary ||
          right.sourceSpecificScore - left.sourceSpecificScore ||
          right.sortTertiary - left.sortTertiary
        );
      }
      return (
        right.sourceSpecificScore - left.sourceSpecificScore ||
        right.sortPrimary - left.sortPrimary ||
        right.sortSecondary - left.sortSecondary ||
        right.sortTertiary - left.sortTertiary
      );
    })
    .map((candidate, index) => {
      const finalRank = index + 1;
      return {
        ...candidate,
        finalRank,
        score: {
          ...candidate.score,
          finalRank
        }
      };
    });
}

function pickRandomTopSourceCandidate(ranked: ShopeeSourceScoredCandidate[]) {
  const topLimit = ranked[0]?.topCandidateLimit ?? 10;
  const topCandidates = ranked.slice(0, Math.max(1, Math.min(topLimit, ranked.length)));
  if (!topCandidates.length) return null;
  return topCandidates[Math.floor(Math.random() * topCandidates.length)] ?? topCandidates[0];
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
          searchVolume: product.searchVolume,
          recentSales: product.recentSales,
          salesVelocity: product.salesVelocity,
          stock: product.stock,
          productCreatedAt: product.productCreatedAt,
          sourceApiSignal: Boolean(product.sourceApiSignal),
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

function getBangkokPostedDate(date = new Date()) {
  const bangkok = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return bangkok.toISOString().slice(0, 10);
}

function getShopeeProductIdentity(product: Pick<ShopeeProductRecord, "productId" | "shopId" | "itemId">) {
  const shopId = String(product.shopId ?? "").trim();
  const itemId = String(product.itemId ?? "").trim();
  if (shopId && itemId) return `${shopId}:${itemId}`;
  return String(product.productId ?? "").trim();
}

async function getShopeeProductLocksForDate(userId: string, postedDate = getBangkokPostedDate()) {
  const histories = (await ProductPostHistory.find({
    userId,
    source: "shopee-affiliate",
    postedDate,
    status: { $in: ["queued", "published"] }
  })
    .select("productId shopId itemId")
    .lean()) as Array<{ productId?: string; shopId?: string; itemId?: string }>;

  const productIds = new Set<string>();
  const identities = new Set<string>();
  for (const history of histories) {
    if (history.productId) productIds.add(String(history.productId));
    const identity = getShopeeProductIdentity({
      productId: String(history.productId ?? ""),
      shopId: String(history.shopId ?? ""),
      itemId: String(history.itemId ?? "")
    });
    if (identity) identities.add(identity);
  }

  return { productIds, identities, postedDate };
}

function shuffleShopeeProducts(products: ShopeeProductRecord[]) {
  const shuffled = [...products];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function dedupeShopeeProducts(products: ShopeeProductRecord[]) {
  const seen = new Set<string>();
  const deduped: ShopeeProductRecord[] = [];
  for (const product of products) {
    const key = getShopeeProductDedupeKey(product);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(product);
  }
  return deduped;
}

function getShopeeProductDedupeKey(product: ShopeeProductRecord) {
  return getShopeeProductIdentity(product) || String(product.productId ?? "").trim();
}

function getRotatedShopeeCategories(categories: string[], seed = Math.random()) {
  if (!categories.length) return [];
  const offset = Math.floor(seed * categories.length) % categories.length;
  return [...categories.slice(offset), ...categories.slice(0, offset)];
}

function getShopeeProductFilterRejectionReason(input: {
  product: ShopeeProductRecord;
  excludedProductIds: Set<string>;
  dailyLocks: { productIds: Set<string>; identities: Set<string> };
  selectedProductIds: Set<string>;
  selectedProductIdentities: Set<string>;
  blockedCategories?: string[];
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  minSales?: number;
  minDiscountPercent?: number;
}) {
  const productId = String(input.product.productId);
  const identity = getShopeeProductIdentity(input.product);
  const effectivePrice = getEffectiveProductPrice(input.product);
  if (input.selectedProductIds.has(productId) || input.selectedProductIdentities.has(identity)) return "already_selected_in_request";
  if (input.excludedProductIds.has(productId)) return "excluded_product_id";
  if (input.dailyLocks.productIds.has(productId) || input.dailyLocks.identities.has(identity)) return "already_posted_today";
  if (!input.product.productImageUrl && !input.product.productImageUrls?.length) return "missing_image";
  if (!input.product.productUrl && !input.product.affiliateUrl) return "missing_product_url";
  if (input.product.stock !== undefined && input.product.stock !== null && toFiniteNumber(input.product.stock) <= 0) return "out_of_stock";
  if (input.blockedCategories?.some((category) => isShopeeCategoryMatch(input.product.category, category))) return "blocked_category";
  if ((input.minPrice ?? 0) > 0 && effectivePrice < (input.minPrice ?? 0)) return "below_min_price";
  if ((input.maxPrice ?? 0) > 0 && effectivePrice > (input.maxPrice ?? 0)) return "above_max_price";
  if ((input.minRating ?? 0) > 0 && (input.product.rating ?? 0) < (input.minRating ?? 0)) return "below_min_rating";
  if ((input.minSales ?? 0) > 0 && (input.product.salesCount ?? 0) < (input.minSales ?? 0)) return "below_min_sales";
  if ((input.minDiscountPercent ?? 0) > 0 && (input.product.discountPercent ?? 0) < (input.minDiscountPercent ?? 0)) return "below_min_discount";
  return null;
}

function logShopeeSourceScoreBreakdown(input: {
  sourceTag: ShopeeSourceTag;
  pageId?: string;
  product: ShopeeProductRecord;
  scoreResult: ShopeeSourceScoreResult;
  finalRank?: number | null;
  selectionStatus: "selected" | "rejected";
  rejectedReason?: string | null;
}) {
  console.info("SHOPEE_SOURCE_SCORE_BREAKDOWN", {
    source: input.sourceTag,
    pageId: input.pageId,
    productId: input.product.productId,
    shopId: input.product.shopId,
    itemId: input.product.itemId,
    productName: input.product.productName,
    sales: input.product.salesCount ?? 0,
    rating: input.product.rating ?? 0,
    reviewCount: input.product.reviewCount ?? 0,
    discount: input.product.discountPercent ?? 0,
    commissionRate: input.product.commissionRate ?? 0,
    price: getEffectiveProductPrice(input.product),
    searchVolume: input.product.searchVolume ?? null,
    sourceSpecificScore: input.scoreResult.sourceSpecificScore,
    scoreBreakdown: input.scoreResult.scoreBreakdown,
    finalRank: input.finalRank ?? null,
    selectionStatus: input.selectionStatus,
    rejectedReason: input.rejectedReason ?? null
  });
}

const PRODUCT_SELECTION_REJECTION_REASONS = [
  "missing_image",
  "missing_product_url",
  "out_of_stock",
  "blocked_category",
  "below_min_price",
  "above_max_price",
  "below_min_rating",
  "below_min_sales",
  "below_min_discount",
  "already_posted_today",
  "recently_posted",
  "below_min_source_score"
] as const;

type ProductSelectionDiagnostics = {
  source: ShopeeSourceTag;
  selectedCategories: string[];
  keyword: string;
  fetchedProducts: number;
  afterDedupe: number;
  afterMissingImageFilter: number;
  afterMissingUrlFilter: number;
  afterOutOfStockFilter: number;
  afterBlockedCategoryFilter: number;
  afterMinPriceFilter: number;
  afterMaxPriceFilter: number;
  afterMinRatingFilter: number;
  afterMinSalesFilter: number;
  afterMinDiscountFilter: number;
  afterAlreadyPostedTodayFilter: number;
  afterRecentlyPostedFilter: number;
  afterSourceScoreFilter: number;
  finalEligibleProducts: number;
  rejectCounts: Record<string, number>;
  topRejectedProducts: Array<Record<string, unknown>>;
  lowScoreBreakdowns: Array<Record<string, unknown>>;
  sourceDataQuality: Record<string, unknown>;
};

function createProductSelectionDiagnostics(input: {
  source: ShopeeSourceTag;
  selectedCategories: string[];
  keyword?: string;
  fetchedProducts: number;
  afterDedupe: number;
  products: ShopeeProductRecord[];
}): ProductSelectionDiagnostics {
  const rejectCounts = Object.fromEntries(PRODUCT_SELECTION_REJECTION_REASONS.map((reason) => [reason, 0])) as Record<string, number>;
  const productsWithSearchVolume = input.products.filter((product) => toFiniteNumber(product.searchVolume) > 0).length;
  const productsWithRecentSales = input.products.filter((product) => toFiniteNumber(product.recentSales) > 0).length;
  const productsWithSalesVelocity = input.products.filter((product) => toFiniteNumber(product.salesVelocity) > 0).length;
  const productsWithSourceApiSignal = input.products.filter((product) => Boolean(product.sourceApiSignal)).length;
  return {
    source: input.source,
    selectedCategories: input.selectedCategories,
    keyword: input.keyword ?? "",
    fetchedProducts: input.fetchedProducts,
    afterDedupe: input.afterDedupe,
    afterMissingImageFilter: 0,
    afterMissingUrlFilter: 0,
    afterOutOfStockFilter: 0,
    afterBlockedCategoryFilter: 0,
    afterMinPriceFilter: 0,
    afterMaxPriceFilter: 0,
    afterMinRatingFilter: 0,
    afterMinSalesFilter: 0,
    afterMinDiscountFilter: 0,
    afterAlreadyPostedTodayFilter: 0,
    afterRecentlyPostedFilter: 0,
    afterSourceScoreFilter: 0,
    finalEligibleProducts: 0,
    rejectCounts,
    topRejectedProducts: [],
    lowScoreBreakdowns: [],
    sourceDataQuality: {
      source: input.source,
      productsWithSearchVolume,
      productsWithRecentSales,
      productsWithSalesVelocity,
      productsWithSourceApiSignal,
      productsWithoutSearchVolume: input.afterDedupe - productsWithSearchVolume,
      productsWithoutRecentSales: input.afterDedupe - productsWithRecentSales,
      productsWithoutSalesVelocity: input.afterDedupe - productsWithSalesVelocity,
      productsWithoutSourceApiSignal: input.afterDedupe - productsWithSourceApiSignal
    }
  };
}

function recordProductSelectionStaticFunnel(input: {
  diagnostics: ProductSelectionDiagnostics;
  product: ShopeeProductRecord;
  dailyLocks: { productIds: Set<string>; identities: Set<string> };
  blockedCategories?: string[];
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  minSales?: number;
  minDiscountPercent?: number;
}) {
  const productId = String(input.product.productId);
  const identity = getShopeeProductIdentity(input.product);
  const effectivePrice = getEffectiveProductPrice(input.product);
  if (!input.product.productImageUrl && !input.product.productImageUrls?.length) return;
  input.diagnostics.afterMissingImageFilter += 1;
  if (!input.product.productUrl && !input.product.affiliateUrl) return;
  input.diagnostics.afterMissingUrlFilter += 1;
  if (input.product.stock !== undefined && input.product.stock !== null && toFiniteNumber(input.product.stock) <= 0) return;
  input.diagnostics.afterOutOfStockFilter += 1;
  if (input.blockedCategories?.some((category) => isShopeeCategoryMatch(input.product.category, category))) return;
  input.diagnostics.afterBlockedCategoryFilter += 1;
  if ((input.minPrice ?? 0) > 0 && effectivePrice < (input.minPrice ?? 0)) return;
  input.diagnostics.afterMinPriceFilter += 1;
  if ((input.maxPrice ?? 0) > 0 && effectivePrice > (input.maxPrice ?? 0)) return;
  input.diagnostics.afterMaxPriceFilter += 1;
  if ((input.minRating ?? 0) > 0 && (input.product.rating ?? 0) < (input.minRating ?? 0)) return;
  input.diagnostics.afterMinRatingFilter += 1;
  if ((input.minSales ?? 0) > 0 && (input.product.salesCount ?? 0) < (input.minSales ?? 0)) return;
  input.diagnostics.afterMinSalesFilter += 1;
  if ((input.minDiscountPercent ?? 0) > 0 && (input.product.discountPercent ?? 0) < (input.minDiscountPercent ?? 0)) return;
  input.diagnostics.afterMinDiscountFilter += 1;
  if (input.diagnostics.rejectCounts.excluded_product_id !== undefined) {
    // no-op; keeps diagnostics read-only and aligned with actual rejection summary keys.
  }
  if (input.dailyLocks.productIds.has(productId) || input.dailyLocks.identities.has(identity)) return;
  input.diagnostics.afterAlreadyPostedTodayFilter += 1;
}

function recordProductSelectionRejection(input: {
  diagnostics: ProductSelectionDiagnostics;
  product: ShopeeProductRecord;
  sourceTag: ShopeeSourceTag;
  scoreResult: ShopeeSourceScoreResult;
  rejectReason: string;
}) {
  input.diagnostics.rejectCounts[input.rejectReason] = (input.diagnostics.rejectCounts[input.rejectReason] ?? 0) + 1;
  if (input.diagnostics.topRejectedProducts.length < 50) {
    input.diagnostics.topRejectedProducts.push({
      productId: input.product.productId,
      title: input.product.productName,
      source: input.sourceTag,
      salesCount: input.product.salesCount ?? 0,
      rating: input.product.rating ?? 0,
      reviewCount: input.product.reviewCount ?? 0,
      discountPercent: input.product.discountPercent ?? 0,
      commissionRate: input.product.commissionRate ?? 0,
      sourceScore: input.scoreResult.sourceSpecificScore,
      rejectReason: input.rejectReason
    });
  }
  if (input.rejectReason === "below_min_source_score" && input.diagnostics.lowScoreBreakdowns.length < 50) {
    const breakdown = input.scoreResult.scoreBreakdown;
    input.diagnostics.lowScoreBreakdowns.push({
      productId: input.product.productId,
      title: input.product.productName,
      source: input.sourceTag,
      salesScore: breakdown.salesScore ?? null,
      ratingScore: breakdown.ratingScore ?? null,
      reviewScore: breakdown.reviewScore ?? null,
      discountScore: breakdown.discountScore ?? null,
      commissionScore: breakdown.commissionRateScore ?? null,
      salesMomentumScore: breakdown.salesMomentumScore ?? null,
      freshnessScore: breakdown.freshnessScore ?? null,
      keywordMatchScore: breakdown.keywordMatchScore ?? null,
      searchVolumeScore: breakdown.searchVolumeScore ?? null,
      sourceApiBonus: breakdown.sourceApiBonus ?? null,
      finalSourceScore: input.scoreResult.sourceSpecificScore
    });
  }
}

function logProductSelectionDiagnostics(diagnostics: ProductSelectionDiagnostics) {
  console.info("PRODUCT_SELECTION_FUNNEL", {
    source: diagnostics.source,
    selectedCategories: diagnostics.selectedCategories,
    keyword: diagnostics.keyword,
    fetchedProducts: diagnostics.fetchedProducts,
    afterDedupe: diagnostics.afterDedupe,
    afterMissingImageFilter: diagnostics.afterMissingImageFilter,
    afterMissingUrlFilter: diagnostics.afterMissingUrlFilter,
    afterOutOfStockFilter: diagnostics.afterOutOfStockFilter,
    afterBlockedCategoryFilter: diagnostics.afterBlockedCategoryFilter,
    afterMinPriceFilter: diagnostics.afterMinPriceFilter,
    afterMaxPriceFilter: diagnostics.afterMaxPriceFilter,
    afterMinRatingFilter: diagnostics.afterMinRatingFilter,
    afterMinSalesFilter: diagnostics.afterMinSalesFilter,
    afterMinDiscountFilter: diagnostics.afterMinDiscountFilter,
    afterAlreadyPostedTodayFilter: diagnostics.afterAlreadyPostedTodayFilter,
    afterRecentlyPostedFilter: diagnostics.afterRecentlyPostedFilter,
    afterSourceScoreFilter: diagnostics.afterSourceScoreFilter,
    finalEligibleProducts: diagnostics.finalEligibleProducts
  });
  console.info("PRODUCT_REJECTION_SUMMARY", {
    fetchedProducts: diagnostics.fetchedProducts,
    rejectCounts: diagnostics.rejectCounts
  });
  console.info("TOP_REJECTED_PRODUCTS", diagnostics.topRejectedProducts);
  console.info("SOURCE_SCORE_BREAKDOWN", diagnostics.lowScoreBreakdowns);
  console.info("SOURCE_DATA_QUALITY", diagnostics.sourceDataQuality);
  const sortedRejects = Object.entries(diagnostics.rejectCounts).sort((left, right) => right[1] - left[1]);
  const [primaryFailureReason = "none", primaryFailureCount = 0] = sortedRejects[0] ?? [];
  const totalRejected = Object.values(diagnostics.rejectCounts).reduce((sum, count) => sum + count, 0);
  const percentage = totalRejected > 0 ? Math.round((primaryFailureCount / totalRejected) * 100) : 0;
  const recommendations: Record<string, string> = {
    missing_image: "Shopee response product pool has products without usable image URLs.",
    missing_product_url: "Shopee response product pool has products without productUrl or affiliateUrl.",
    out_of_stock: "Shopee response product pool is mostly out of stock.",
    blocked_category: "Configured blocked categories are eliminating the fetched product pool.",
    below_min_price: "Configured minimum price is higher than most fetched products.",
    above_max_price: "Configured maximum price is lower than most fetched products.",
    below_min_rating: "Configured minimum rating is higher than most fetched products.",
    below_min_sales: "Configured minimum sales is higher than most fetched products.",
    below_min_discount: "Configured minimum discount is higher than most fetched products.",
    already_posted_today: "Daily duplicate protection is eliminating the fetched product pool.",
    recently_posted: "Recent-post duplicate protection is eliminating products for the selected page.",
    below_min_source_score: "Source-specific score relies on signals that are weak or missing from Shopee API responses."
  };
  console.info("PRODUCT_SELECTION_ROOT_CAUSE", {
    fetchedProducts: diagnostics.fetchedProducts,
    eligibleProducts: diagnostics.finalEligibleProducts,
    primaryFailureReason,
    percentage,
    recommendation: recommendations[primaryFailureReason] ?? "Inspect PRODUCT_REJECTION_SUMMARY and TOP_REJECTED_PRODUCTS for the dominant rejection reason."
  });
}

export async function selectShopeeProductsForPages(input: {
  userId: string;
  pageIds: string[];
  sourceTag?: ShopeeSourceTag;
  keyword?: string;
  category?: string;
  categories?: string[];
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
  const sourceTag = input.sourceTag ?? "trending";
  assertManualKeywordProvided({ sourceTag, keyword: input.keyword });
  const excludedProductIds = new Set((input.excludedProductIds ?? []).map((productId) => String(productId)).filter(Boolean));
  const dailyLocks = process.env.AUTO_POST_NO_DUPLICATE_SAME_DAY === "false"
    ? { productIds: new Set<string>(), identities: new Set<string>(), postedDate: getBangkokPostedDate() }
    : await getShopeeProductLocksForDate(input.userId);
  const categories = normalizeShopeeCategories(input.categories?.length ? input.categories : input.category);
  const discoveryCategories = categories.length ? categories : [DEFAULT_SHOPEE_CATEGORY];
  const requestedPoolSize = Math.max(30, input.pageIds.length * Math.max(5, excludedProductIds.size + 5));
  const limitPerCategory = Math.max(30, Math.min(50, requestedPoolSize));
  const effectiveCategoryPriority = input.categoryPriority?.length ? input.categoryPriority : categories;
  const discoveredByCategory: ShopeeProductRecord[][] = [];
  const discoveredCategoryHints = new Map<string, Set<string>>();
  const categoryFetchErrors: string[] = [];
  for (const category of discoveryCategories) {
    try {
      const categoryProducts = await provider.fetchProducts({
        sourceTag,
        keyword: input.keyword,
        category,
        limit: limitPerCategory
      });
      discoveredByCategory.push(categoryProducts);
      for (const product of categoryProducts) {
        const key = getShopeeProductDedupeKey(product);
        const hints = discoveredCategoryHints.get(key) ?? new Set<string>();
        hints.add(category);
        discoveredCategoryHints.set(key, hints);
      }
    } catch (error) {
      categoryFetchErrors.push(`${category}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!discoveredByCategory.length && categoryFetchErrors.length) {
    throw new Error(`Unable to fetch Shopee products for selected categories: ${categoryFetchErrors.join("; ")}`);
  }
  const discovered = shuffleShopeeProducts(dedupeShopeeProducts(discoveredByCategory.flat()));
  await upsertShopeeProducts(discovered);
  const selectionDiagnostics = createProductSelectionDiagnostics({
    source: sourceTag,
    selectedCategories: discoveryCategories,
    keyword: input.keyword,
    fetchedProducts: discoveredByCategory.flat().length,
    afterDedupe: discovered.length,
    products: discovered
  });

  const selected: Array<{ pageId: string; product: ShopeeProductRecord; score: ProductScore }> = [];
  const selectedProductIds = new Set<string>();
  const selectedProductIdentities = new Set<string>();

  const rotatedCategories = getRotatedShopeeCategories(categories);
  const productMatchesPreferredCategory = (product: ShopeeProductRecord, category: string) => {
    const hintedCategories = discoveredCategoryHints.get(getShopeeProductDedupeKey(product));
    return Boolean(hintedCategories?.has(category)) || isShopeeCategoryMatch(product.category, category);
  };

  for (const pageId of input.pageIds) {
    const scored: ShopeeSourceScoredCandidate[] = [];
    for (const product of discovered) {
      const scoreResult = scoreShopeeProductForSource({
        product,
        sourceTag,
        keyword: input.keyword,
        categories: effectiveCategoryPriority
      });
      recordProductSelectionStaticFunnel({
        diagnostics: selectionDiagnostics,
        product,
        dailyLocks,
        blockedCategories: input.blockedCategories,
        minPrice: input.minPrice,
        maxPrice: input.maxPrice,
        minRating: input.minRating,
        minSales: input.minSales,
        minDiscountPercent: input.minDiscountPercent
      });
      const staticRejection = getShopeeProductFilterRejectionReason({
        product,
        excludedProductIds,
        dailyLocks,
        selectedProductIds,
        selectedProductIdentities,
        blockedCategories: input.blockedCategories,
        minPrice: input.minPrice,
        maxPrice: input.maxPrice,
        minRating: input.minRating,
        minSales: input.minSales,
        minDiscountPercent: input.minDiscountPercent
      });
      if (staticRejection) {
        logShopeeSourceScoreBreakdown({
          sourceTag,
          pageId,
          product,
          scoreResult,
          finalRank: null,
          selectionStatus: "rejected",
          rejectedReason: staticRejection
        });
        recordProductSelectionRejection({
          diagnostics: selectionDiagnostics,
          product,
          sourceTag,
          scoreResult,
          rejectReason: staticRejection
        });
        continue;
      }
      const recentlyPosted = await wasProductRecentlyPosted(input.userId, pageId, product.productId);
      if (recentlyPosted) {
        logShopeeSourceScoreBreakdown({
          sourceTag,
          pageId,
          product,
          scoreResult,
          finalRank: null,
          selectionStatus: "rejected",
          rejectedReason: "recently_posted"
        });
        recordProductSelectionRejection({
          diagnostics: selectionDiagnostics,
          product,
          sourceTag,
          scoreResult,
          rejectReason: "recently_posted"
        });
        continue;
      }
      selectionDiagnostics.afterRecentlyPostedFilter += 1;
      if (scoreResult.sourceSpecificScore < SHOPEE_MIN_SOURCE_SPECIFIC_SCORE) {
        logShopeeSourceScoreBreakdown({
          sourceTag,
          pageId,
          product,
          scoreResult,
          finalRank: null,
          selectionStatus: "rejected",
          rejectedReason: "below_min_source_score"
        });
        recordProductSelectionRejection({
          diagnostics: selectionDiagnostics,
          product,
          sourceTag,
          scoreResult,
          rejectReason: "below_min_source_score"
        });
        continue;
      }
      selectionDiagnostics.afterSourceScoreFilter += 1;
      const legacyRiskScore = scoreShopeeProduct({
        product,
        recentlyPosted,
        categoryPriority: effectiveCategoryPriority,
        blockedCategories: input.blockedCategories
      });
      const mergedRiskFlags = Array.from(new Set([...scoreResult.score.riskFlags, ...legacyRiskScore.riskFlags]));
      scored.push({
        product,
        ...scoreResult,
        score: {
          ...scoreResult.score,
          riskFlags: mergedRiskFlags
        }
      });
    }

    const pageIndex = input.pageIds.indexOf(pageId);
    const preferredCategory = rotatedCategories.length ? rotatedCategories[pageIndex % rotatedCategories.length] : "";
    const preferredCandidates = preferredCategory
      ? scored.filter((item) => productMatchesPreferredCategory(item.product, preferredCategory))
      : [];
    const ranked = sourceSpecificRankedSelection(preferredCandidates.length ? preferredCandidates : scored, sourceTag);
    const best = pickRandomTopSourceCandidate(ranked);

    for (const candidate of ranked) {
      logShopeeSourceScoreBreakdown({
        sourceTag,
        pageId,
        product: candidate.product,
        scoreResult: candidate,
        finalRank: candidate.finalRank ?? null,
        selectionStatus: best?.product.productId === candidate.product.productId ? "selected" : "rejected",
        rejectedReason: best?.product.productId === candidate.product.productId
          ? null
          : (candidate.finalRank ?? 0) <= candidate.topCandidateLimit
            ? "top_candidate_not_randomly_selected"
            : "outside_top_candidates"
      });
    }

    if (!best) {
      continue;
    }

    selectedProductIds.add(String(best.product.productId));
    selectedProductIdentities.add(getShopeeProductIdentity(best.product));
    selected.push({ pageId, product: best.product, score: best.score });
  }

  selectionDiagnostics.finalEligibleProducts = selected.length;
  logProductSelectionDiagnostics(selectionDiagnostics);

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
  jobId?: string;
}) {
  const { product } = input;
  const titleInfo = getShopeeCleanedProductTitleInfo(product.productName);
  let productUnderstanding = extractShopeeProductUnderstanding(product);
  const imageCount = [product.productImageUrl, ...(product.productImageUrls ?? [])].filter((url) => Boolean(url?.trim())).length;

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "PRODUCT_TITLE_CLEANED",
    status: "success",
    message: "Shopee product title cleaned before Storyboard",
    metadata: {
      productId: product.productId,
      rawTitle: titleInfo.rawTitle,
      cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
      productEntity: productUnderstanding.productEntity,
      productType: productUnderstanding.productType,
      mainUseCase: productUnderstanding.mainUseCase,
      targetAudience: productUnderstanding.targetAudience,
      confidence: productUnderstanding.confidence,
      brand: productUnderstanding.brand ?? "",
      model: productUnderstanding.model ?? "",
      removedNoiseWords: productUnderstanding.removedNoiseWords
    }
  });

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "TEXT_UNDERSTANDING_RESULT",
    status: productUnderstanding.failureReasons.length ? "failed" : "success",
    message: "Text-only product understanding completed",
    metadata: {
      productId: product.productId,
      cleanTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
      productEntity: productUnderstanding.productEntity,
      productType: productUnderstanding.productType,
      mainUseCase: productUnderstanding.mainUseCase,
      targetAudience: productUnderstanding.targetAudience,
      confidence: productUnderstanding.confidence
    }
  });

  const rescueImageUrl = getFirstValidShopeeProductImageUrl(product);
  let productUnderstandingMergedLogged = false;
  if (productUnderstanding.confidence < 80 && rescueImageUrl && imageCount > 0) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product,
      step: "VISION_RESCUE_TRIGGERED",
      status: "started",
      message: "Text confidence is low; running vision rescue on the first product image",
      metadata: {
        productId: product.productId,
        reason: "low_confidence",
        textConfidence: productUnderstanding.confidence,
        imageUrl: rescueImageUrl
      }
    });

    try {
      const visionUnderstanding = await analyzeShopeeProductImageUnderstanding({
        imageUrl: rescueImageUrl,
        productTitle: product.productName,
        productDescription: product.productDescription,
        timeoutMs: VISION_RESCUE_TIMEOUT_MS
      });
      await logShopeePackageStage({
        userId: input.userId,
        jobId: input.jobId,
        product,
        step: "VISION_UNDERSTANDING_RESULT",
        status: visionUnderstanding.visionConfidence >= 75 ? "success" : "failed",
        message: "Vision rescue returned product understanding",
        metadata: {
          productId: product.productId,
          visionProductEntity: visionUnderstanding.visionProductEntity,
          visionProductType: visionUnderstanding.visionProductType,
          visionMainUseCase: visionUnderstanding.visionMainUseCase,
          visionTargetAudience: visionUnderstanding.visionTargetAudience,
          visionConfidence: visionUnderstanding.visionConfidence,
          visualEvidence: visionUnderstanding.visualEvidence
        }
      });
      productUnderstanding = mergeShopeeVisionUnderstanding(product, productUnderstanding, visionUnderstanding);
      await logShopeePackageStage({
        userId: input.userId,
        jobId: input.jobId,
        product,
        step: "PRODUCT_UNDERSTANDING_MERGED",
        status: productUnderstanding.failureReasons.length ? "failed" : "success",
        message: "Text and vision understanding merged before Storyboard",
        metadata: {
          productId: product.productId,
          source: productUnderstanding.source,
          productEntity: productUnderstanding.productEntity,
          productType: productUnderstanding.productType,
          mainUseCase: productUnderstanding.mainUseCase,
          targetAudience: productUnderstanding.targetAudience,
          confidence: productUnderstanding.confidence
        }
      });
      productUnderstandingMergedLogged = true;
    } catch (error) {
      await logShopeePackageStage({
        userId: input.userId,
        jobId: input.jobId,
        product,
        step: "VISION_RESCUE_FAILED",
        status: "failed",
        message: "Vision rescue failed; falling back to text understanding if validation allows it",
        metadata: {
          productId: product.productId,
          reason: "vision_rescue_failed",
          textConfidence: productUnderstanding.confidence,
          imageUrl: rescueImageUrl
        },
        error
      });
    }
  }

  if (!productUnderstandingMergedLogged) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product,
      step: "PRODUCT_UNDERSTANDING_MERGED",
      status: productUnderstanding.failureReasons.length ? "failed" : "success",
      message: "Final product understanding selected before Storyboard",
      metadata: {
        productId: product.productId,
        source: productUnderstanding.source,
        productEntity: productUnderstanding.productEntity,
        productType: productUnderstanding.productType,
        mainUseCase: productUnderstanding.mainUseCase,
        targetAudience: productUnderstanding.targetAudience,
        confidence: productUnderstanding.confidence
      }
    });
  }

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "PRODUCT_UNDERSTANDING_STARTED",
    status: "started",
    message: "Extracting Shopee product entity, type, use case, and target audience",
    metadata: {
      productId: product.productId,
      rawTitle: titleInfo.rawTitle,
      cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle
    }
  });

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "PRODUCT_UNDERSTANDING_AUDIT",
    status: productUnderstanding.failureReasons.length ? "failed" : "success",
    message: "Product understanding audit captured before Storyboard and Caption",
    metadata: getShopeeProductUnderstandingAuditPayload(product, productUnderstanding)
  });

  try {
    assertValidShopeeProductUnderstanding(productUnderstanding, product);
  } catch (error) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product,
      step: "PRODUCT_UNDERSTANDING_DEBUG",
      status: "failed",
      message: "Product understanding debug payload captured",
      metadata: getShopeeProductUnderstandingDebugPayload(product, productUnderstanding)
    });
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product,
      step: "PRODUCT_UNDERSTANDING_FAILED",
      status: "failed",
      message: "Product understanding validation failed before Storyboard",
      metadata: {
        productId: product.productId,
        rawTitle: productUnderstanding.rawTitle,
        cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
        productEntity: productUnderstanding.productEntity,
        productType: productUnderstanding.productType,
        mainUseCase: productUnderstanding.mainUseCase,
        targetAudience: productUnderstanding.targetAudience,
        confidence: productUnderstanding.confidence,
        failureReasons: productUnderstanding.failureReasons
      },
      error
    });
    throw error;
  }

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "PRODUCT_UNDERSTANDING_COMPLETED",
    status: "success",
    message: "Product understanding validated before Storyboard",
    metadata: {
      productId: product.productId,
      rawTitle: productUnderstanding.rawTitle,
      cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
      productEntity: productUnderstanding.productEntity,
      productType: productUnderstanding.productType,
      mainUseCase: productUnderstanding.mainUseCase,
      targetAudience: productUnderstanding.targetAudience,
      confidence: productUnderstanding.confidence
    }
  });

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "PRODUCT_VALIDATION_STARTED",
    status: "started",
    message: "Validating minimum Shopee product data before Storyboard",
    metadata: {
      productId: product.productId,
      cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
      productEntity: productUnderstanding.productEntity,
      productType: productUnderstanding.productType,
      mainUseCase: productUnderstanding.mainUseCase,
      targetAudience: productUnderstanding.targetAudience,
      rawTitle: titleInfo.rawTitle,
      imageCount,
      shortLinkExists: Boolean(input.affiliateLink?.trim())
    }
  });

  if (!hasShopeeProductName(product)) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product,
      step: "PRODUCT_VALIDATION_FAILED",
      status: "failed",
      message: "Product validation failed before Storyboard: missing title",
      metadata: {
        productId: product.productId,
        rawTitle: titleInfo.rawTitle,
        cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
        reason: "missing_title",
        validatorName: "minimumProductData"
      }
    });
    throw new ShopeeProviderError(
      `caption generation failed: SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT missing product name for ${product.productId}`,
      422,
      "missing_product_name",
      "internal_api"
    );
  }
  if (!hasShopeeProductImage(product)) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product,
      step: "PRODUCT_VALIDATION_FAILED",
      status: "failed",
      message: "Product validation failed before Storyboard: missing image",
      metadata: {
        productId: product.productId,
        rawTitle: titleInfo.rawTitle,
        cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
        reason: "missing_images",
        validatorName: "minimumProductData"
      }
    });
    throw new ShopeeProviderError(
      `caption generation failed: SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT missing product image for ${product.productId}`,
      422,
      "missing_images",
      "internal_api"
    );
  }
  if (!input.affiliateLink?.trim()) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product,
      step: "PRODUCT_VALIDATION_FAILED",
      status: "failed",
      message: "Product validation failed before Storyboard: missing short link",
      metadata: {
        productId: product.productId,
        rawTitle: titleInfo.rawTitle,
        cleanedTitle: titleInfo.cleanedTitle,
        reason: "missing_shortlink",
        validatorName: "minimumProductData"
      }
    });
    throw new ShopeeProviderError(
      `caption generation failed: SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT missing short link for ${product.productId}`,
      422,
      "missing_shortlink",
      "internal_api"
    );
  }

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "PRODUCT_VALIDATION_PASSED",
    status: "success",
    message: "Product passed minimum validation before Storyboard",
    metadata: {
      productId: product.productId,
      cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
      productEntity: productUnderstanding.productEntity,
      productType: productUnderstanding.productType,
      mainUseCase: productUnderstanding.mainUseCase,
      targetAudience: productUnderstanding.targetAudience,
      validatorName: "minimumProductData"
    }
  });

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product,
    step: "STORYBOARD_INPUT_READY",
    status: "success",
    message: "Product input is ready for Storyboard",
    metadata: {
      productId: product.productId,
      cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
      productEntity: productUnderstanding.productEntity,
      productType: productUnderstanding.productType,
      mainUseCase: productUnderstanding.mainUseCase,
      targetAudience: productUnderstanding.targetAudience,
      descriptionExists: Boolean(product.productDescription?.trim()),
      imageCount,
      shortLinkExists: Boolean(input.affiliateLink?.trim())
    }
  });

  const productForStoryboard: ShopeeProductRecord = {
    ...product,
    productName: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle || product.productName
  };

  const storyboardStartedAt = new Date();
  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product: productForStoryboard,
    step: "STORYBOARD_STARTED",
    status: "started",
    message: "Creating Product Storyboard for Shopee caption",
    metadata: {
      rawTitle: titleInfo.rawTitle,
      cleanedTitle: productUnderstanding.cleanedTitle || titleInfo.cleanedTitle,
      productEntity: productUnderstanding.productEntity,
      productType: productUnderstanding.productType,
      mainUseCase: productUnderstanding.mainUseCase,
      targetAudience: productUnderstanding.targetAudience,
      confidence: productUnderstanding.confidence,
      brand: productUnderstanding.brand ?? "",
      model: productUnderstanding.model ?? "",
      hasProductName: hasShopeeProductName(productForStoryboard),
      hasProductImage: hasShopeeProductImage(productForStoryboard),
      imageCount,
      storyboardStartedAt: storyboardStartedAt.toISOString(),
      provider: getShopeeStoryboardProvider(),
      timeoutMs: STORYBOARD_TIMEOUT_MS
    }
  });

  let storyboard: ShopeeProductStoryboard;
  try {
    storyboard = await createShopeeProductStoryboardWithRetry({
      userId: input.userId,
      jobId: input.jobId,
      product: productForStoryboard
    });
  } catch (error) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product: productForStoryboard,
      step: "STORYBOARD_FAILED",
      status: "failed",
      message: "Product Storyboard creation failed",
      error
    });
    throw error;
  }

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product: productForStoryboard,
    step: "STORYBOARD_CREATED",
    status: "success",
    message: "Product Storyboard created",
    metadata: {
      productSimpleName: storyboard.productSimpleName,
      productEntity: storyboard.productEntity,
      brand: storyboard.brand ?? "",
      model: storyboard.model ?? "",
      productType: storyboard.productType,
      whatItIs: storyboard.whatItIs,
      mainUseCase: storyboard.mainUseCase,
      captionAngle: storyboard.captionAngle,
      hasProblemSolved: Boolean(storyboard.problemSolved),
      hasDailyBenefit: Boolean(storyboard.dailyBenefit),
      hasRealUsageScenario: Boolean(storyboard.realUsageScenario),
      storyboardCompletedAt: new Date().toISOString(),
      storyboardDurationMs: Date.now() - storyboardStartedAt.getTime(),
      provider: getShopeeStoryboardProvider()
    }
  });

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product: productForStoryboard,
    step: "CAPTION_STARTED",
    status: "started",
    message: "Generating caption from Product Storyboard",
    metadata: {
      storyboardType: storyboard.productType,
      shortLink: input.affiliateLink
    }
  });

  let storyboardCaption: string;
  try {
    storyboardCaption = buildShopeeStoryboardCaption({
      product: productForStoryboard,
      storyboard,
      affiliateLink: input.affiliateLink,
      jobId: input.jobId
    });
  } catch (error) {
    if (error instanceof ShopeeProviderError && error.code === "caption_readability_failed") {
      let detail: Record<string, unknown> = {};
      try {
        detail = error.responseSummary ? JSON.parse(error.responseSummary) as Record<string, unknown> : {};
      } catch {
        detail = {};
      }
      await logShopeePackageStage({
        userId: input.userId,
        jobId: input.jobId,
        product: productForStoryboard,
        step: "CAPTION_READABILITY_FAILED",
        status: "failed",
        message: "Caption failed human readability validation",
        metadata: {
          productId: product.productId,
          productEntity: storyboard.productEntity,
          captionPreview: String(detail.captionPreview ?? "").slice(0, 500),
          detectedIssues: Array.isArray(detail.detectedIssues) ? detail.detectedIssues : []
        },
        error
      });
    }
    await logShopeeAutomationEvent({
      userId: input.userId,
      level: "error",
      message: "CAPTION_VALIDATION_FAILED_DETAIL",
      productId: product.productId,
      metadata: {
        jobId: input.jobId ?? "",
        productId: product.productId,
        productName: product.productName,
        shortLink: input.affiliateLink,
        validatorName: "validateStoryboardAffiliateCaption",
        errorCode: error instanceof ShopeeProviderError ? error.code : "",
        errorMessage: error instanceof Error ? error.message : String(error),
        responseSummary: error instanceof ShopeeProviderError ? error.responseSummary ?? "" : ""
      }
    });
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      product: productForStoryboard,
      step: "CAPTION_FAILED",
      status: "failed",
      message: "Caption generation from Product Storyboard failed",
      metadata: {
        storyboardType: storyboard.productType,
        validatorName: "validateStoryboardAffiliateCaption"
      },
      error
    });
    throw error;
  }
  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    product: productForStoryboard,
    step: "CAPTION_CREATED",
    status: "success",
    message: "Caption created from Product Storyboard",
    metadata: {
      storyboardType: storyboard.productType,
      captionLength: storyboardCaption.length,
      captionPreview: storyboardCaption.slice(0, 240),
      shortLink: input.affiliateLink
    }
  });
  await logShopeeAutomationEvent({
    userId: input.userId,
    level: "success",
    message: "CAPTION_VALIDATION_PASSED",
    productId: product.productId,
    metadata: {
      jobId: input.jobId ?? "",
      productId: product.productId,
      productName: product.productName,
      shortLink: input.affiliateLink,
      validatorName: "validateStoryboardAffiliateCaption",
      captionPreview: storyboardCaption.slice(0, 240)
    }
  });
  console.info("[CAPTION_GENERATED_FROM_STORYBOARD]", {
    productId: product.productId,
    productName: product.productName,
    productType: storyboard.productType
  });
  return storyboardCaption;

}

async function fetchShopeeReferenceImage(url: string) {
  const requestStartedAt = Date.now();
  const response = await traceExternalRequest(
    {
      step: "SHOPEE_REFERENCE_IMAGE_FETCH",
      url,
      fn: "fetchShopeeReferenceImage",
      source: "image_generation_reference_fetch"
    },
    () => fetch(url, { cache: "no-store" })
  );
  if (!response.ok) {
    await logExternalResponseFailure({
      step: "SHOPEE_REFERENCE_IMAGE_FETCH",
      url,
      fn: "fetchShopeeReferenceImage",
      source: "image_generation_reference_fetch",
      responseTime: Date.now() - requestStartedAt,
      status: response.status,
      errorMessage: `Unable to fetch Shopee reference image: ${response.status}`
    });
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

async function logShopeePackageStage(input: {
  userId: string;
  jobId?: string;
  pageId?: string;
  product?: ShopeeProductRecord;
  step: string;
  status: "started" | "success" | "failed";
  message: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
}) {
  await logShopeeAutomationEvent({
    userId: input.userId,
    level: input.status === "failed" ? "error" : "info",
    message: `${input.step}: ${input.message}`,
    pageId: input.pageId,
    productId: input.product?.productId,
    metadata: {
      step: input.step,
      status: input.status,
      workflowRunId: input.jobId,
      productId: input.product?.productId,
      productName: input.product?.productName,
      ...(input.metadata ?? {}),
      ...(input.error
        ? {
            errorMessage: input.error instanceof Error ? input.error.message : String(input.error),
            stack: input.error instanceof Error ? input.error.stack?.slice(0, 3000) : undefined,
            serializedError: serializeError(input.error)
          }
        : {})
    }
  });
}

type ShopeePackageStageLogInput = Parameters<typeof logShopeePackageStage>[0];

async function logShopeeTimedStageStart(input: {
  userId: string;
  jobId?: string;
  pageId?: string;
  product?: ShopeeProductRecord;
  stage: string;
  startedAt: Date;
  metadata?: Record<string, unknown>;
}) {
  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "STAGE_START",
    status: "started",
    message: `${input.stage} started`,
    metadata: {
      stage: input.stage,
      startedAt: input.startedAt.toISOString(),
      ...(input.metadata ?? {})
    }
  });
}

async function logShopeeTimedStageEnd(input: {
  userId: string;
  jobId?: string;
  pageId?: string;
  product?: ShopeeProductRecord;
  stage: string;
  startedAt: Date;
  status: "success" | "failed";
  metadata?: Record<string, unknown>;
  error?: unknown;
}) {
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - input.startedAt.getTime();
  const metadata = {
    stage: input.stage,
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    STAGE_DURATION_MS: durationMs,
    durationMs,
    ...(input.metadata ?? {})
  };

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "STAGE_END",
    status: input.status,
    message: `${input.stage} ${input.status === "success" ? "completed" : "failed"} in ${durationMs}ms`,
    metadata,
    error: input.error
  });

  if (durationMs > AUTO_POST_SLOW_STAGE_WARNING_MS) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      step: "WARNING_STAGE_SLOW",
      status: "success",
      message: `${input.stage} exceeded ${AUTO_POST_SLOW_STAGE_WARNING_MS}ms (${durationMs}ms)`,
      metadata
    });
  }
}

async function runShopeeTimedStage<T>(input: {
  userId: string;
  jobId?: string;
  pageId?: string;
  product?: ShopeeProductRecord;
  stage: string;
  metadata?: Record<string, unknown>;
  fn: () => Promise<T> | T;
}) {
  const startedAt = new Date();
  await logShopeeTimedStageStart({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    stage: input.stage,
    startedAt,
    metadata: input.metadata
  });

  try {
    const result = await input.fn();
    await logShopeeTimedStageEnd({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      stage: input.stage,
      startedAt,
      status: "success",
      metadata: input.metadata
    });
    return result;
  } catch (error) {
    await logShopeeTimedStageEnd({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      stage: input.stage,
      startedAt,
      status: "failed",
      metadata: input.metadata,
      error
    });
    throw error;
  }
}

function isOpenAiImageTimeoutError(error: unknown) {
  if (error instanceof ShopeeProviderError && error.code === "openai_image_timeout") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("openai image request timeout");
}

function getErrorMessage(error: unknown, fallback = "Unknown error") {
  return error instanceof Error ? error.message : String(error ?? fallback);
}

function getErrorStack(error: unknown) {
  return error instanceof Error ? error.stack?.slice(0, 3000) : undefined;
}

function classifyImageFailureSource(error: unknown, fallback: string) {
  const message = getErrorMessage(error, "").toLowerCase();
  const code = error instanceof ShopeeProviderError ? error.code : "";
  const providerSource = error instanceof ShopeeProviderError ? error.source : "";

  if (
    fallback === "openai" ||
    code.includes("openai") ||
    message.includes("openai") ||
    message.includes("image request timeout")
  ) {
    return "openai";
  }

  if (
    fallback === "validation" ||
    code.includes("validation") ||
    message.includes("duplicate ugc") ||
    message.includes("original shopee product image") ||
    message.includes("reference image") ||
    message.includes("expected")
  ) {
    return "validation";
  }

  if (fallback === "blob" || providerSource.includes("blob") || message.includes("blob")) {
    return "blob_upload";
  }

  if (fallback === "mongo" || message.includes("mongo") || message.includes("mongoose")) {
    return "mongo_save";
  }

  return fallback;
}

function withOpenAiImageTimeout<T>(producer: () => Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback();
    };

    timeout = setTimeout(() => {
      settle(() =>
        reject(
          new ShopeeProviderError(
            `OpenAI image request timeout after ${timeoutMs}ms`,
            504,
            "openai_image_timeout",
            "internal_api"
          )
        )
      );
    }, timeoutMs);

    Promise.resolve()
      .then(producer)
      .then((value) => settle(() => resolve(value)))
      .catch((error) => settle(() => reject(error)));
  });
}

async function generateShopeeUgcImageWithTracing(input: {
  userId: string;
  jobId?: string;
  product: ShopeeProductRecord;
  imageIndex: number;
  imageCount: number;
  attempt: number;
  primaryReference: { bytes: Buffer; mimeType: string };
  referenceImages: Array<{ bytes: Buffer; mimeType: string }>;
  prompt: string;
}) {
  const provider = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1";
  const startedAt = new Date();
  const requestId = crypto.randomUUID();
  let loggingDurationMs = 0;
  const promptLength = input.prompt.length;
  const timedLog = async (logInput: ShopeePackageStageLogInput) => {
    const logStartedAt = Date.now();
    await logShopeePackageStage(logInput);
    loggingDurationMs += Date.now() - logStartedAt;
  };
  const baseMetadata = {
    requestId,
    imageIndex: input.imageIndex,
    imageCount: input.imageCount,
    attempt: input.attempt,
    retryCount: Math.max(0, input.attempt - 1),
    maxAttempts: OPENAI_IMAGE_MAX_ATTEMPTS,
    provider,
    timeoutMs: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
    startedAt: startedAt.toISOString(),
    promptLength,
    referenceImageCount: input.referenceImages.length + 1
  };

  await timedLog({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    step: "OPENAI_IMAGE_REQUEST_START",
    status: "started",
    message: `OpenAI image request started for UGC image ${input.imageIndex}/${input.imageCount}`,
    metadata: baseMetadata
  });

  try {
    const generatedBuffer = await withOpenAiImageTimeout(
      () => generateProductReferenceImage({
        imageBytes: bufferToArrayBuffer(input.primaryReference.bytes),
        mimeType: input.primaryReference.mimeType,
        prompt: input.prompt,
        userId: input.userId,
        timeoutMs: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
        referenceImages: input.referenceImages.map((reference) => ({
          imageBytes: bufferToArrayBuffer(reference.bytes),
          mimeType: reference.mimeType
        }))
      }),
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS
    );
    const completedAt = new Date();
    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "OPENAI_IMAGE_REQUEST_END",
      status: "success",
      message: `OpenAI image request completed for UGC image ${input.imageIndex}/${input.imageCount}`,
      metadata: {
        ...baseMetadata,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        loggingDurationMs,
        sizeBytes: generatedBuffer.length
      }
    });
    return {
      buffer: generatedBuffer,
      requestDurationMs: completedAt.getTime() - startedAt.getTime(),
      loggingDurationMs,
      promptLength
    };
  } catch (error) {
    const completedAt = new Date();
    const timeout = isOpenAiImageTimeoutError(error);
    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: timeout ? "OPENAI_IMAGE_TIMEOUT" : "OPENAI_IMAGE_REQUEST_FAILED",
      status: "failed",
      message: timeout
        ? `OpenAI image request timed out for UGC image ${input.imageIndex}/${input.imageCount}`
        : `OpenAI image request failed for UGC image ${input.imageIndex}/${input.imageCount}`,
      metadata: {
        ...baseMetadata,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        loggingDurationMs
      },
      error
    });
    throw error;
  }
}

async function generateShopeeUgcImageDocs(input: {
  userId: string;
  jobId?: string;
  product: ShopeeProductRecord;
  promptSet: ReturnType<typeof buildShopeeImagePromptSet>;
  sourceImageUrls: string[];
}) {
  const totalStartedAt = Date.now();
  let loggingDurationMs = 0;
  let blobUploadDurationMs = 0;
  let imageRequestCount = 0;
  const imageDurations: Record<string, number> = {};
  const imagePromptLengths: Record<string, number> = {};
  const timedLog = async (logInput: ShopeePackageStageLogInput) => {
    const logStartedAt = Date.now();
    await logShopeePackageStage(logInput);
    loggingDurationMs += Date.now() - logStartedAt;
  };
  const imageGenerationStageStartedAt = new Date();
  await logShopeeTimedStageStart({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    stage: "IMAGE_GENERATION",
    startedAt: imageGenerationStageStartedAt,
    metadata: {
      expectedImages: input.promptSet.prompts.length,
      sourceImageCount: input.sourceImageUrls.length
    }
  });

  try {
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

  const sourceHashes = await runShopeeTimedStage({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    stage: "IMAGE_VALIDATION",
    metadata: {
      validationStep: "reference_hashes",
      referenceImageCount: referenceImages.length
    },
    fn: () => new Set(referenceImages.map((image) => hashImageBuffer(image.bytes)))
  });
  type GeneratedUgcImage = {
    index: number;
    promptItem: (typeof input.promptSet.prompts)[number];
    prompt: string;
    buffer: Buffer;
    hash: string;
    requestDurationMs: number;
    loggingDurationMs: number;
  };
  const imageDocs = [];
  let imageTaskSuccessCount = 0;
  let imageTaskFailedCount = 0;

  await timedLog({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    step: "IMAGE_GENERATION_MODE",
    status: "started",
    message: "Shopee UGC images will be generated in parallel",
    metadata: {
      mode: "parallel",
      reason: "OpenAI image edits run concurrently, then validation/upload/database save run as batch stages",
      expectedImages: input.promptSet.prompts.length,
      referenceImageCount: referenceImages.length,
      maxAttemptsPerImage: OPENAI_IMAGE_MAX_ATTEMPTS
    }
  });

  const generationTasks = input.promptSet.prompts.map((promptItem, index) => {
    const primaryReference = referenceImages[index % referenceImages.length];
    const prompt = [
      promptItem.prompt,
      `Generate image ${index + 1} of 4 only. This image must have a unique angle, environment, distance, camera framing, hand position, and usage context compared with the other three images.`,
      "Use all attached Shopee images as product identity references. Create a new realistic UGC lifestyle photo; do not copy, crop, resize, or reuse the original Shopee product image composition.",
      "No text, no overlay, no product card, no catalog background, no studio packshot."
    ].join("\n");
    imagePromptLengths[`IMAGE_${index + 1}_PROMPT_LENGTH`] = prompt.length;

    return async (): Promise<GeneratedUgcImage> => {
      const imageIndex = index + 1;
      const imageTaskId = crypto.randomUUID();
      const imageTaskStartedAt = Date.now();
      let generatedBuffer: Buffer | null = null;
      let lastError: unknown = null;
      let imageLoggingDurationMs = 0;
      let requestDurationMs = 0;

      await timedLog({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        step: "IMAGE_TASK_STARTED",
        status: "started",
        message: `UGC image task ${imageIndex}/${input.promptSet.prompts.length} started`,
        metadata: {
          imageTaskId,
          imageIndex,
          imageCount: input.promptSet.prompts.length,
          expectedImageCount: input.promptSet.prompts.length,
          source: "openai",
          promptLength: prompt.length,
          referenceImageCount: referenceImages.length,
          maxAttempts: OPENAI_IMAGE_MAX_ATTEMPTS
        }
      });

      try {
      await timedLog({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        step: "IMAGE_PROMPT_LENGTH",
        status: "success",
        message: `UGC image ${index + 1} prompt length measured`,
        metadata: {
          imageIndex: index + 1,
          imageCount: input.promptSet.prompts.length,
          promptLength: prompt.length,
          basePromptLength: promptItem.prompt.length,
          addedInstructionLength: prompt.length - promptItem.prompt.length,
          referenceImageCount: referenceImages.length
        }
      });

      for (let attempt = 1; attempt <= OPENAI_IMAGE_MAX_ATTEMPTS; attempt += 1) {
        try {
          imageRequestCount += 1;
          const imageResult = await generateShopeeUgcImageWithTracing({
            userId: input.userId,
            jobId: input.jobId,
            product: input.product,
            imageIndex: index + 1,
            imageCount: input.promptSet.prompts.length,
            attempt,
            primaryReference,
            referenceImages: referenceImages.filter((_, referenceIndex) => referenceIndex !== index % referenceImages.length),
            prompt
          });
          generatedBuffer = imageResult.buffer;
          imageLoggingDurationMs += imageResult.loggingDurationMs;
          loggingDurationMs += imageResult.loggingDurationMs;
          requestDurationMs = imageResult.requestDurationMs;
          imageDurations[`IMAGE_${index + 1}_DURATION`] = imageResult.requestDurationMs;
          const generatedHash = hashImageBuffer(generatedBuffer);
          if (sourceHashes.has(generatedHash)) {
            throw new Error("OpenAI returned the original Shopee product image instead of a new UGC lifestyle image");
          }
          imageTaskSuccessCount += 1;
          await timedLog({
            userId: input.userId,
            jobId: input.jobId,
            product: input.product,
            step: "IMAGE_TASK_COMPLETED",
            status: "success",
            message: `UGC image task ${imageIndex}/${input.promptSet.prompts.length} completed`,
            metadata: {
              imageTaskId,
              imageIndex,
              imageCount: input.promptSet.prompts.length,
              expectedImageCount: input.promptSet.prompts.length,
              successCount: imageTaskSuccessCount,
              failedCount: imageTaskFailedCount,
              attempt,
              retryCount: Math.max(0, attempt - 1),
              source: "openai",
              requestDurationMs,
              imageTaskDurationMs: Date.now() - imageTaskStartedAt,
              sizeBytes: generatedBuffer.length,
              hash: generatedHash
            }
          });
          return {
            index,
            promptItem,
            prompt,
            buffer: generatedBuffer,
            hash: generatedHash,
            requestDurationMs,
            loggingDurationMs: imageLoggingDurationMs
          };
        } catch (error) {
          lastError = error;
          generatedBuffer = null;
        }
      }

      const taskError = new ShopeeProviderError(
        `Shopee UGC image generation failed: ${lastError instanceof Error ? lastError.message : "OpenAI did not return a usable UGC image"}`,
        500,
        "shopee_ugc_image_generation_failed",
        "internal_api"
      );
      throw taskError;
      } catch (error) {
        imageTaskFailedCount += 1;
        const source = classifyImageFailureSource(error, classifyImageFailureSource(lastError, "openai"));
        const reason = getErrorMessage(error, "UGC image task failed");
        await timedLog({
          userId: input.userId,
          jobId: input.jobId,
          product: input.product,
          step: "IMAGE_TASK_FAILED",
          status: "failed",
          message: `UGC image task ${imageIndex}/${input.promptSet.prompts.length} failed`,
          metadata: {
            imageTaskId,
            imageIndex,
            imageCount: input.promptSet.prompts.length,
            expectedImageCount: input.promptSet.prompts.length,
            successCount: imageTaskSuccessCount,
            failedCount: imageTaskFailedCount,
            source,
            reason,
            stack: getErrorStack(error),
            lastAttemptErrorMessage: lastError ? getErrorMessage(lastError) : null,
            lastAttemptErrorSource: lastError ? classifyImageFailureSource(lastError, "openai") : null,
            imageTaskDurationMs: Date.now() - imageTaskStartedAt
          },
          error
        });
        throw error;
      }
    };
  });

  let generatedImages: GeneratedUgcImage[];
  try {
    generatedImages = await Promise.all(generationTasks.map((task) => task()));
  } catch (error) {
    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "IMAGE_BATCH_FAILED",
      status: "failed",
      message: "Shopee UGC image batch failed during parallel generation",
      metadata: {
        expectedImageCount: input.promptSet.prompts.length,
        successCount: imageTaskSuccessCount,
        failedCount: imageTaskFailedCount,
        generatedImages: imageTaskSuccessCount,
        source: classifyImageFailureSource(error, "openai"),
        reason: getErrorMessage(error, "Parallel image generation failed"),
        stack: getErrorStack(error),
        mode: "parallel"
      },
      error
    });
    throw error;
  }

  await timedLog({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    step: "IMAGE_COUNT_CHECK",
    status: "success",
    message: "Parallel UGC image generation count checked before validation",
    metadata: {
      expectedImageCount: input.promptSet.prompts.length,
      generatedImages: generatedImages.length,
      successCount: imageTaskSuccessCount,
      failedCount: imageTaskFailedCount,
      source: "validation",
      mode: "parallel"
    }
  });
  if (generatedImages.length < input.promptSet.prompts.length) {
    const countError = new ShopeeProviderError(
      `Shopee UGC image generation incomplete: expected ${input.promptSet.prompts.length}, generated ${generatedImages.length}`,
      500,
      "shopee_image_generation_incomplete",
      "internal_api"
    );
    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "IMAGE_COUNT_CHECK_FAILED",
      status: "failed",
      message: "Parallel UGC image generation count was incomplete before validation",
      metadata: {
        expectedImageCount: input.promptSet.prompts.length,
        generatedImages: generatedImages.length,
        successCount: imageTaskSuccessCount,
        failedCount: imageTaskFailedCount,
        source: "validation",
        reason: countError.message,
        stack: getErrorStack(countError),
        mode: "parallel"
      },
      error: countError
    });
    throw countError;
  }

  await runShopeeTimedStage({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    stage: "IMAGE_VALIDATION",
    metadata: {
      validationStep: "parallel_generated_hash_compare",
      imageCount: generatedImages.length,
      generatedImages: generatedImages.length,
      expectedImageCount: input.promptSet.prompts.length,
      successCount: imageTaskSuccessCount,
      sourceHashCount: sourceHashes.size
    },
    fn: () => {
      const generatedHashes = new Set<string>();
      for (const generated of generatedImages) {
        if (sourceHashes.has(generated.hash)) {
          throw new Error("OpenAI returned the original Shopee product image instead of a new UGC lifestyle image");
        }
        if (generatedHashes.has(generated.hash)) {
          throw new Error("OpenAI returned duplicate UGC images");
        }
        generatedHashes.add(generated.hash);
      }
      return generatedHashes;
    }
  });

  const uploadedImageDocs = await Promise.all(generatedImages.map(async (generated) => {
    const index = generated.index;
    const blobStartedAt = Date.now();
    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "BLOB_UPLOAD_STARTED",
      status: "started",
      message: `Uploading UGC image ${index + 1} to Vercel Blob`,
      metadata: {
        imageIndex: index + 1,
        imageCount: input.promptSet.prompts.length,
        expectedImageCount: input.promptSet.prompts.length,
        sizeBytes: generated.buffer.length,
        source: "blob_upload"
      }
    });

    let uploadedImage: Awaited<ReturnType<typeof uploadAutoPostImage>>;
    try {
      const uploadStartedAt = Date.now();
      uploadedImage = await runShopeeTimedStage({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        stage: "BLOB_UPLOAD",
        metadata: {
          imageIndex: index + 1,
          imageCount: input.promptSet.prompts.length,
          expectedImageCount: input.promptSet.prompts.length,
          sizeBytes: generated.buffer.length,
          source: "blob_upload"
        },
        fn: () => uploadAutoPostImage({
          jobId: input.jobId ?? `shopee-${Date.now()}`,
          productId: input.product.productId,
          index: index + 1,
          buffer: generated.buffer,
          mimeType: "image/png",
          kind: "image"
        })
      });
      blobUploadDurationMs += Date.now() - uploadStartedAt;
    } catch (error) {
      blobUploadDurationMs += Date.now() - blobStartedAt;
      await timedLog({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        step: "BLOB_UPLOAD_FAILED",
        status: "failed",
        message: `Failed to upload UGC image ${index + 1} to Vercel Blob`,
        metadata: {
          imageIndex: index + 1,
          imageCount: input.promptSet.prompts.length,
          expectedImageCount: input.promptSet.prompts.length,
          source: "blob_upload",
          reason: getErrorMessage(error, "Blob upload failed"),
          stack: getErrorStack(error)
        },
        error
      });
      throw error;
    }

    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "BLOB_UPLOAD_COMPLETED",
      status: "success",
      message: `Uploaded UGC image ${index + 1} to Vercel Blob`,
      metadata: {
        imageIndex: index + 1,
        imageCount: input.promptSet.prompts.length,
        expectedImageCount: input.promptSet.prompts.length,
        imageUrl: uploadedImage.url,
        pathname: uploadedImage.pathname,
        contentType: uploadedImage.contentType,
        sizeBytes: uploadedImage.sizeBytes,
        blobUploadDurationMs: Date.now() - blobStartedAt,
        imageLoggingDurationMs: generated.loggingDurationMs,
        source: "blob_upload"
      }
    });

    const imagePayload = {
      userId: input.userId,
      productId: input.product.productId,
      prompt: generated.promptItem.prompt,
      status: "generated",
      generatedImageUrl: uploadedImage.url,
      pathname: uploadedImage.pathname,
      fallbackImageUrl: input.product.productImageUrl || input.sourceImageUrls[0],
      provider: "vercel_blob_openai_shopee_ugc_photo",
      contentType: uploadedImage.contentType,
      sizeBytes: uploadedImage.sizeBytes,
      promptHistory: [
        generated.promptItem.title,
        `concept=${generated.promptItem.concept}`,
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
    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "MONGO_SAVE_STARTED",
      status: "started",
      message: `Saving UGC image ${index + 1} metadata to MongoDB`,
      metadata: {
        collection: "AiGeneratedImage",
        imageIndex: index + 1,
        imageCount: input.promptSet.prompts.length,
        expectedImageCount: input.promptSet.prompts.length,
        pathname: uploadedImage.pathname,
        source: "mongo_save"
      }
    });
    try {
      const imageDoc = await runShopeeTimedStage({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        stage: "DATABASE_SAVE",
        metadata: {
          collection: "AiGeneratedImage",
          imageIndex: index + 1,
          imageCount: input.promptSet.prompts.length,
          expectedImageCount: input.promptSet.prompts.length,
          pathname: uploadedImage.pathname,
          source: "mongo_save"
        },
        fn: () => AiGeneratedImage.create(imagePayload)
      });
      await timedLog({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        step: "MONGO_SAVE_COMPLETED",
        status: "success",
        message: `Saved UGC image ${index + 1} metadata to MongoDB`,
        metadata: {
          collection: "AiGeneratedImage",
          imageIndex: index + 1,
          imageCount: input.promptSet.prompts.length,
          expectedImageCount: input.promptSet.prompts.length,
          imageId: String(imageDoc._id),
          pathname: uploadedImage.pathname,
          source: "mongo_save"
        }
      });
      return imageDoc;
    } catch (error) {
      await timedLog({
        userId: input.userId,
        jobId: input.jobId,
        product: input.product,
        step: "MONGO_SAVE_FAILED",
        status: "failed",
        message: `Failed to save UGC image ${index + 1} metadata to MongoDB`,
        metadata: {
          collection: "AiGeneratedImage",
          imageIndex: index + 1,
          imageCount: input.promptSet.prompts.length,
          expectedImageCount: input.promptSet.prompts.length,
          pathname: uploadedImage.pathname,
          source: "mongo_save",
          reason: getErrorMessage(error, "Mongo save failed"),
          stack: getErrorStack(error)
        },
        error
      });
      throw error;
    }
  }));
  imageDocs.push(...uploadedImageDocs);
  imageDocs.sort((left, right) => {
    const leftHistory = Array.isArray(left.promptHistory) ? left.promptHistory : [];
    const rightHistory = Array.isArray(right.promptHistory) ? right.promptHistory : [];
    const leftLayout = Number(String(leftHistory.find((item: unknown) => String(item).startsWith("layout=")) ?? "layout=0").replace("layout=", ""));
    const rightLayout = Number(String(rightHistory.find((item: unknown) => String(item).startsWith("layout=")) ?? "layout=0").replace("layout=", ""));
    return leftLayout - rightLayout;
  });

  await timedLog({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    step: "IMAGE_DOC_COUNT_CHECK",
    status: "success",
    message: "Saved UGC image document count checked before marking image generation complete",
    metadata: {
      expectedImageCount: input.promptSet.prompts.length,
      generatedImages: imageDocs.length,
      successCount: imageDocs.length,
      source: "mongo_save",
      mode: "parallel"
    }
  });
  if (imageDocs.length < input.promptSet.prompts.length) {
    const countError = new ShopeeProviderError(
      `Shopee UGC image document save incomplete: expected ${input.promptSet.prompts.length}, saved ${imageDocs.length}`,
      500,
      "shopee_image_document_save_incomplete",
      "internal_api"
    );
    await timedLog({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      step: "IMAGE_DOC_COUNT_CHECK_FAILED",
      status: "failed",
      message: "Saved UGC image document count was incomplete before completion",
      metadata: {
        expectedImageCount: input.promptSet.prompts.length,
        generatedImages: imageDocs.length,
        successCount: imageDocs.length,
        source: "mongo_save",
        reason: countError.message,
        stack: getErrorStack(countError),
        mode: "parallel"
      },
      error: countError
    });
    throw countError;
  }

  const totalImageDurationMs = Date.now() - totalStartedAt;
  await timedLog({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    step: "IMAGE_REQUEST_COUNT",
    status: "success",
    message: "Shopee UGC image request count measured",
    metadata: {
      imageRequestCount,
      expectedImages: input.promptSet.prompts.length,
      maxAttemptsPerImage: OPENAI_IMAGE_MAX_ATTEMPTS,
      mode: "parallel"
    }
  });
  await timedLog({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    step: "TOTAL_IMAGE_DURATION",
    status: "success",
    message: "Shopee UGC image generation performance summary",
    metadata: {
      mode: "parallel",
      imageRequestCount,
      expectedImages: input.promptSet.prompts.length,
      generatedImages: imageDocs.length,
      ...imagePromptLengths,
      ...imageDurations,
      BLOB_UPLOAD_DURATION: blobUploadDurationMs,
      LOGGING_DURATION: loggingDurationMs,
      TOTAL_IMAGE_DURATION: totalImageDurationMs
    }
  });

  await logShopeeTimedStageEnd({
    userId: input.userId,
    jobId: input.jobId,
    product: input.product,
    stage: "IMAGE_GENERATION",
    startedAt: imageGenerationStageStartedAt,
    status: "success",
    metadata: {
      expectedImages: input.promptSet.prompts.length,
      generatedImages: imageDocs.length,
      IMAGE_REQUEST_COUNT: imageRequestCount,
      TOTAL_IMAGE_DURATION: totalImageDurationMs,
      BLOB_UPLOAD_DURATION: blobUploadDurationMs,
      LOGGING_DURATION: loggingDurationMs
    }
  });
  return imageDocs;
  } catch (error) {
    await logShopeeTimedStageEnd({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      stage: "IMAGE_GENERATION",
      startedAt: imageGenerationStageStartedAt,
      status: "failed",
      metadata: {
        expectedImages: input.promptSet.prompts.length,
        IMAGE_REQUEST_COUNT: imageRequestCount,
        BLOB_UPLOAD_DURATION: blobUploadDurationMs,
        LOGGING_DURATION: loggingDurationMs
      },
      error
    });
    throw error;
  }
}

export async function buildShopeePostPackage(input: {
  userId: string;
  pageId: string;
  product: ShopeeProductRecord;
  scheduledAt: Date;
  captionStyle?: ShopeeCaptionStyle;
  trackingId?: string;
  jobId?: string;
}) {
  const contextStartedAt = new Date();
  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "PRODUCT_CONTEXT_CREATE_STARTED",
    status: "started",
    message: "Creating Shopee product context before package generation",
    metadata: {
      productId: input.product.productId,
      productName: input.product.productName,
      pageId: input.pageId,
      captionStyle: input.captionStyle ?? "soft_sell",
      trackingId: input.trackingId ?? "",
      scheduledAt: input.scheduledAt.toISOString(),
      reason: "waiting_for_product_context"
    }
  });

  const sourceImageUrls = (input.product.productImageUrls?.length ? input.product.productImageUrls : [input.product.productImageUrl])
    .filter((url): url is string => Boolean(url?.trim()));
  const imagePromptSet = buildShopeeImagePromptSet(input.product, input.captionStyle ?? "soft_sell");
  const imagePrompts = imagePromptSet.prompts.map((item) => item.prompt);
  const imagePrompt = imagePrompts[0] ?? buildShopeeImagePrompt(input.product, input.captionStyle ?? "soft_sell");

  if (sourceImageUrls.length === 0) {
    const error = new ShopeeProviderError(
      "Shopee UGC image generation failed: product image is missing",
      422,
      "shopee_ugc_reference_image_unavailable",
      "internal_api"
    );
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      step: "PRODUCT_CONTEXT_CREATE_FAILED",
      status: "failed",
      message: "Shopee product context creation failed before package generation",
      metadata: {
        productId: input.product.productId,
        reason: "missing_product_image",
        sourceImageCount: sourceImageUrls.length,
        promptCount: imagePromptSet.prompts.length,
        durationMs: Date.now() - contextStartedAt.getTime()
      },
      error
    });
    throw error;
  }

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "PRODUCT_CONTEXT_CREATE_COMPLETED",
    status: "success",
    message: "Shopee product context created before package generation",
    metadata: {
      productId: input.product.productId,
      sourceImageCount: sourceImageUrls.length,
      promptCount: imagePromptSet.prompts.length,
      expectedImageCount: imagePromptSet.prompts.length,
      imagePromptLength: imagePrompt.length,
      durationMs: Date.now() - contextStartedAt.getTime()
    }
  });

  const linkResult = await createOrReuseAffiliateShortLink({
    userId: input.userId,
    product: input.product,
    trackingId: input.trackingId,
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
  const caption = await generateShopeeCaption({
    userId: input.userId,
    product: input.product,
    affiliateLink: shortAffiliateLink,
    style: input.captionStyle,
    jobId: input.jobId
  });

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "UGC_IMAGES_STARTED",
    status: "started",
    message: "Generating Shopee UGC images",
    metadata: {
      expectedImages: imagePromptSet.prompts.length,
      expectedImageCount: imagePromptSet.prompts.length,
      sourceImageCount: sourceImageUrls.length,
      promptCount: imagePromptSet.prompts.length
    }
  });

  let imageDocs: Awaited<ReturnType<typeof generateShopeeUgcImageDocs>>;
  try {
    imageDocs = await generateShopeeUgcImageDocs({
      userId: input.userId,
      jobId: input.jobId,
      product: input.product,
      promptSet: imagePromptSet,
      sourceImageUrls
    });
  } catch (error) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      step: "UGC_IMAGES_FAILED",
      status: "failed",
      message: "Shopee UGC image generation failed",
      metadata: {
        expectedImages: imagePromptSet.prompts.length,
        expectedImageCount: imagePromptSet.prompts.length,
        sourceImageCount: sourceImageUrls.length,
        promptCount: imagePromptSet.prompts.length,
        source: classifyImageFailureSource(error, "openai"),
        reason: getErrorMessage(error, "Shopee UGC image generation failed"),
        stack: getErrorStack(error)
      },
      error
    });
    throw error;
  }

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "UGC_IMAGES_CREATED",
    status: "success",
    message: "Shopee UGC images generated",
    metadata: {
      imageCount: imageDocs.length,
      imageUrls: imageDocs.map((imageDoc) => imageDoc.generatedImageUrl).filter(Boolean),
      blobUrls: imageDocs.map((imageDoc) => imageDoc.generatedImageUrl).filter(Boolean),
      imageIds: imageDocs.map((imageDoc) => String(imageDoc._id))
    }
  });

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "TEMPLATE_POST_CREATE_STARTED",
    status: "started",
    message: "Creating AI generated template post package",
    metadata: {
      hasStoryboard: true,
      hasCaption: Boolean(caption),
      imageCount: imageDocs.length,
      imageUrls: imageDocs.map((imageDoc) => `ai-image:${String(imageDoc._id)}`),
      blobUrls: imageDocs.map((imageDoc) => imageDoc.generatedImageUrl).filter(Boolean),
      shortAffiliateLink
    }
  });

  let postDoc: any;
  try {
    postDoc = await runShopeeTimedStage({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      stage: "TEMPLATE_POST_CREATE",
      metadata: {
        collection: "AiGeneratedPost",
        imageCount: imageDocs.length,
        shortAffiliateLink,
        scheduledAt: input.scheduledAt.toISOString()
      },
      fn: () => AiGeneratedPost.create({
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
          promptCount: imagePrompts.length
        }
      })
    });
  } catch (error) {
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      step: "TEMPLATE_POST_CREATE_FAILED",
      status: "failed",
      message: "AI generated template post package creation failed",
      metadata: {
        jobId: input.jobId,
        productId: input.product.productId,
        hasStoryboard: true,
        hasCaption: Boolean(caption),
        imageCount: imageDocs.length,
        imageUrls: imageDocs.map((imageDoc) => `ai-image:${String(imageDoc._id)}`),
        blobUrls: imageDocs.map((imageDoc) => imageDoc.generatedImageUrl).filter(Boolean),
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.slice(0, 3000) : undefined
      },
      error
    });
    throw error;
  }

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "TEMPLATE_POST_CREATED",
    status: "success",
    message: "AI generated template post package created",
    metadata: {
      templatePostId: String(postDoc._id),
      aiGeneratedPostId: String(postDoc._id),
      imageCount: imageDocs.length,
      imageUrls: imageDocs.map((imageDoc) => `ai-image:${String(imageDoc._id)}`),
      blobUrls: imageDocs.map((imageDoc) => imageDoc.generatedImageUrl).filter(Boolean),
      shortAffiliateLink
    }
  });
  const generatedImageUrls = imageDocs.map((imageDoc) => `ai-image:${String(imageDoc._id)}`);

  await logShopeePackageStage({
    userId: input.userId,
    jobId: input.jobId,
    pageId: input.pageId,
    product: input.product,
    step: "PACKAGE_IMAGE_COUNT_CHECK",
    status: "success",
    message: "Post package image count checked before package completion",
    metadata: {
      expectedImageCount: imagePromptSet.prompts.length,
      generatedImages: generatedImageUrls.length,
      successCount: generatedImageUrls.length,
      source: "validation",
      imageUrls: generatedImageUrls
    }
  });
  if (generatedImageUrls.length < imagePromptSet.prompts.length) {
    const countError = new ShopeeProviderError(
      `AI image generation failed: expected ${imagePromptSet.prompts.length} post images, generated ${generatedImageUrls.length}`,
      500,
      "shopee_image_generation_incomplete",
      "internal_api"
    );
    await logShopeePackageStage({
      userId: input.userId,
      jobId: input.jobId,
      pageId: input.pageId,
      product: input.product,
      step: "PACKAGE_IMAGE_COUNT_CHECK_FAILED",
      status: "failed",
      message: "Post package image count was incomplete before package completion",
      metadata: {
        expectedImageCount: imagePromptSet.prompts.length,
        generatedImages: generatedImageUrls.length,
        successCount: generatedImageUrls.length,
        source: "validation",
        reason: countError.message,
        stack: getErrorStack(countError),
        imageUrls: generatedImageUrls
      },
      error: countError
    });
    throw countError;
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
    shopId: input.product.shopId ?? "",
    itemId: input.product.itemId ?? "",
    productName: input.product.productName ?? "",
    category: input.product.category ?? "",
    productSource: input.product.sourceTag ?? "shopee-affiliate",
    postId: input.postId,
    affiliateLink: input.affiliateLink,
    shortLink: input.affiliateLink,
    postedDate: getBangkokPostedDate(input.scheduledAt),
    jobId: input.jobId ?? "",
    pageIds: [input.pageId],
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
  const metadata = {
    autoPost: true,
    shopeeAffiliate: true,
    productId: input.productId,
    pageId: input.pageId,
    ...(input.metadata ?? {})
  };

  const withLogTimeout = async (label: string, promise: Promise<unknown>) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label} timed out after ${SHOPEE_ACTION_LOG_TIMEOUT_MS}ms`)), SHOPEE_ACTION_LOG_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      console.warn("[SHOPEE_LOG_WRITE_SKIPPED]", {
        label,
        message: error instanceof Error ? error.message : String(error),
        eventMessage: input.message,
        productId: input.productId,
        pageId: input.pageId
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  await withLogTimeout("ActionLog", logAction({
    userId: input.userId,
    type: "queue",
    level: input.level,
    message: input.message,
    metadata
  }));

  if (SHOPEE_AUTOMATION_LOG_MIRROR_ENABLED) {
    await withLogTimeout("AutomationLog", AutomationLog.create({
      userId: input.userId,
      source: "shopee-affiliate",
      level: input.level,
      message: input.message,
      productId: input.productId,
      pageId: input.pageId,
      metadata
    }));
  }
}


