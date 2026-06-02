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
import { assertValidTextEncoding, normalizeTextEncoding, validateTextEncoding } from "@/lib/services/text-encoding";
import {
  DEFAULT_SHOPEE_CATEGORY,
  getShopeeCategoryLabel,
  getShopeeCategorySearchTerms,
  isShopeeCategoryMatch,
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

export class MockShopeeProvider implements ShopeeProductProvider {
  name = "mock_shopee_provider";

  async fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]> {
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
  const keyword = query.keyword?.trim() || getShopeeCategorySearchTerms(query.category)[0] || "";
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
      hasCategory: normalizeShopeeCategory(input.query.category) !== DEFAULT_SHOPEE_CATEGORY
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
    hasCategory: normalizeShopeeCategory(input.query.category) !== DEFAULT_SHOPEE_CATEGORY,
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
  "เหมาะสำหรับผู้ใช้งานทั่วไป",
  "เหมาะกับหมวด General",
  "เหมาะกับหมวด Lifestyle",
  "เหมาะกับหมวด Beauty",
  "เหมาะกับหมวด",
  "เหมาะกับการใช้งานทั่วไป",
  "คุ้มค่ากับราคา",
  "จากข้อมูลสินค้า",
  "จากรายละเอียดสินค้า",
  "ใช้งานได้จริง",
  "คุณสมบัติสินค้า",
  "สินค้าประเภท",
  "จุดเด่นที่ชอบ:",
  "ความรู้สึกหลังใช้งาน:",
  "ความรู้สึกหลังใช้:",
  "เหตุผลที่ซื้อ:",
  "ลองเช็กโปรหน้าสินค้าได้เลย",
  "รับประกันร้านค้า",
  "จัดส่งเร็ว",
  "General",
  "Lifestyle",
  "Beauty"
];

const SHOPEE_REAL_REVIEW_CTAS = [
  "🛒 ใครกำลังมองหาของแนวนี้ ลองกดดูรายละเอียดเพิ่มเติมได้เลย",
  "🛒 ผมแปะพิกัดไว้ให้แล้ว ลองเข้าไปดูรีวิวเพิ่มเติมได้ครับ"
];

function randomText(items: string[]) {
  return items[Math.floor(Math.random() * items.length)] ?? items[0] ?? "";
}

function compactProductText(value?: string, max = 92) {
  const normalized = (value ?? "").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? normalized.slice(0, max).replace(/\s+\S*$/, "") + "..." : normalized;
}

export function getShopeeCaptionProductName(productName?: string) {
  const cleaned = normalizeTextEncoding(productName ?? "")
    .replace(/^\s*\[[^\]]*(?:แถม|โปร|ลด|ส่งฟรี|sale|deal)[^\]]*\]\s*/giu, "")
    .replace(/^\s*(?:แถม|โปร|ลด|ส่งฟรี|sale|deal)\s*[:：-]?\s*/giu, "")
    .replace(/\s+/g, " ")
    .trim();
  return compactProductText(cleaned || productName || TH.defaultProductName, 120);
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

function containsForbiddenShopeeGenericText(value?: string) {
  const normalized = normalizeTextEncoding(value ?? "").toLowerCase();
  if (!normalized) return false;
  return SHOPEE_FORBIDDEN_GENERIC_PHRASES.some((phrase) => normalized.includes(phrase.toLowerCase()));
}

function isBadShopeeFact(value?: string, product?: ShopeeProductRecord) {
  const normalized = normalizeTextEncoding(value ?? "").trim();
  if (!normalized) return true;
  if (containsForbiddenShopeeGenericText(normalized)) return true;
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

function normalizeShopeeBullet(value: string, max = 86, product?: ShopeeProductRecord) {
  const cleaned = compactProductText(
    normalizeTextEncoding(value)
      .replace(/^[*•\-✅\s]+/u, "")
      .replace(/^(จุดเด่น|รายละเอียด|feature|detail)\s*[:：]?\s*/i, "")
      .trim(),
    max
  );
  if (isBadShopeeFact(cleaned, product)) return "";
  return `✅ ${cleaned}`;
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
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""}`).toLowerCase();
  const options = (() => {
    if (/ไหมขัดฟัน|floss|dental|ช่องปาก|ฟัน/.test(haystack)) return ["ซื้อครั้งเดียวใช้ได้นานหลายเดือน", "หยิบใช้หลังแปรงฟันแล้วรู้สึกสะอาดขึ้น"];
    if (/กางเกง|short|sportswear|วิ่ง|กีฬา|ฟิตเนส/.test(haystack)) return ["ใส่วิ่งแล้วคล่องตัวกว่าที่คิด", "ผ้าเบา ใส่ซ้อมหรือใส่อยู่บ้านก็สบาย"];
    if (/แก้ว|tumbler|เก็บความเย็น|น้ำแข็ง|ขวดน้ำ/.test(haystack)) return ["น้ำแข็งยังอยู่หลังเลิกงาน", "พกไปทำงานแล้วไม่ต้องเติมน้ำบ่อย"];
    if (/กระเป๋า|bag|เป้|คาดอก|wallet/.test(haystack)) return ["ช่องเก็บของเยอะกว่าที่คิด", "หยิบของง่ายขึ้นเวลาออกจากบ้าน"];
    if (/พัดลม|fan|ระบายอากาศ/.test(haystack)) return ["อากาศร้อน ๆ พกไว้คือช่วยได้เยอะ", "ลมแรงกว่าขนาดที่เห็นจริง"];
    if (/รองเท้า|shoe|sneaker|แตะ/.test(haystack)) return ["ใส่เดินทั้งวันแล้วยังสบายเท้า", "แมตช์ชุดง่ายกว่าที่คิด"];
    if (/ซักผ้า|น้ำยาซัก|ปรับผ้านุ่ม|detergent|laundry|fineline/.test(haystack)) return ["ใช้อยู่แล้ว พอเจอโปรเลยกดตุนไว้", "บ้านไหนซักผ้าบ่อย ตัวนี้หยิบใช้ได้เรื่อย ๆ"];
    if (/วิตามิน|supplement|อาหารเสริม|vitamin|dr\.?pong/.test(haystack)) return ["ขวดเดียวพกไว้กินต่อเนื่องได้ง่าย", "เม็ดขนาดกำลังดี หยิบกินง่าย"];
    if (/ขนม|snack|อาหาร|เปี๊ยะ|คุกกี้|เค้ก/.test(haystack)) return ["แพ็กนี้หยิบกินง่าย แบ่งไว้กินได้หลายรอบ", "รสชาติกินเพลินกว่าที่คิด"];
    return ["ขนาดกำลังดี หยิบใช้ง่ายกว่าที่คิด", "ส่วนตัวชอบตรงที่หยิบมาใช้ได้บ่อย", "บ้านไหนใช้บ่อยน่าจะตอบโจทย์"];
  })();
  const chosen = compactProductText(randomText(options), 90);
  return isBadShopeeFact(chosen, product) ? "ส่วนตัวชอบตรงที่หยิบมาใช้ได้บ่อย" : chosen;
}

function buildShopeeReviewFeeling(product: ShopeeProductRecord) {
  const facts = collectShopeeProductFacts(product).map((line) => stripShopeeLeadingEmoji(line)).filter((line) => !isBadShopeeFact(line, product));
  const primaryFact = facts[0];
  const templates = primaryFact
    ? [
        `${primaryFact} พอใช้แล้วรู้สึกว่าสะดวกขึ้นกว่าที่คิด`,
        `ส่วนตัวชอบตรงที่ ${primaryFact} หยิบใช้ได้เรื่อย ๆ ไม่ยุ่งยาก`,
        `${primaryFact} ฟีลโดยรวมคือเหมาะกับคนที่ใช้ของแนวนี้บ่อย`
      ]
    : [
        "ขนาดกำลังดี หยิบใช้ง่าย ใช้ในชีวิตประจำวันได้สบาย",
        "ลองแล้วชอบกว่าที่คิด รายละเอียดเล็ก ๆ ทำให้หยิบใช้บ่อยขึ้น",
        "ส่วนตัวชอบตรงที่ใช้ง่าย ไม่ต้องคิดเยอะ เหมาะกับมีติดบ้านไว้"
      ];
  const selected = compactProductText(randomText(templates), 170);
  return containsForbiddenShopeeGenericText(selected) ? "ส่วนตัวชอบตรงที่ใช้ง่าย หยิบมาใช้ได้บ่อย" : selected;
}

function buildShopeeUsageSituation(product: ShopeeProductRecord) {
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""}`).toLowerCase();
  const options = (() => {
    if (/ไหมขัดฟัน|floss|dental|ช่องปาก|ฟัน/.test(haystack)) return ["วางไว้ในห้องน้ำแล้วหยิบใช้หลังแปรงฟันได้ง่ายขึ้น"];
    if (/กางเกง|short|sportswear|วิ่ง|กีฬา|ฟิตเนส/.test(haystack)) return ["ใส่ไปวิ่งหรือฟิตเนสแล้วขยับตัวได้คล่อง ไม่รู้สึกเกะกะ"];
    if (/แก้ว|tumbler|เก็บความเย็น|น้ำแข็ง|ขวดน้ำ/.test(haystack)) return ["พกไปทำงานหรือวางไว้บนโต๊ะทั้งวันแล้วหยิบดื่มได้เรื่อย ๆ"];
    if (/กระเป๋า|bag|เป้|คาดอก|wallet/.test(haystack)) return ["สะพายออกไปข้างนอกแล้วของจุกจิกอยู่เป็นที่ หยิบง่ายกว่าเดิม"];
    if (/พัดลม|fan|ระบายอากาศ/.test(haystack)) return ["พกติดโต๊ะทำงานหรือใส่กระเป๋าไว้ วันที่ร้อน ๆ ช่วยได้เยอะ"];
    if (/รองเท้า|shoe|sneaker|แตะ/.test(haystack)) return ["ใส่เดินเล่นหรือออกไปทำธุระได้ง่าย แมตช์กับชุดประจำวันได้สบาย"];
    if (/ซักผ้า|น้ำยาซัก|ปรับผ้านุ่ม|detergent|laundry|fineline/.test(haystack)) return ["ซื้อไว้ใช้ซักผ้าที่บ้าน รอบซักบ่อย ๆ จะรู้สึกว่ามีติดไว้แล้วสะดวก"];
    if (/วิตามิน|supplement|อาหารเสริม|vitamin|dr\.?pong/.test(haystack)) return ["วางไว้บนโต๊ะหรือพกติดกระเป๋าไว้ กินตาม routine ได้ง่ายขึ้น"];
    if (/ขนม|snack|อาหาร|เปี๊ยะ|คุกกี้|เค้ก/.test(haystack)) return ["แยกไว้กินเล่นหรือแบ่งกับคนที่บ้านได้ง่าย เหมาะกับช่วงอยากมีของว่างติดไว้"];
    return ["เอาไว้ใช้ในชีวิตประจำวันแล้วสะดวกขึ้นกว่าที่คิด เหมาะกับมีติดบ้านไว้"];
  })();
  const selected = compactProductText(randomText(options), 150);
  return containsForbiddenShopeeGenericText(selected) ? "เอาไว้ใช้ในชีวิตประจำวันแล้วสะดวกขึ้นกว่าที่คิด" : selected;
}

function buildShopeeDetailBullets(product: ShopeeProductRecord) {
  const facts = collectShopeeProductFacts(product).slice(0, 4);
  if (facts.length >= 2) return facts;
  const haystack = normalizeTextEncoding(`${product.productName} ${product.productDescription || ""}`).toLowerCase();
  const fallbackFacts: string[] = [];
  if (/ซักผ้า|น้ำยาซัก|detergent|laundry|fineline/.test(haystack)) fallbackFacts.push("✅ กลิ่นหอมกำลังดี", "✅ ปริมาณเยอะ ใช้ได้นาน", "✅ เหมาะกับบ้านที่ซักผ้าบ่อย");
  if (/วิตามิน|supplement|vitamin/.test(haystack)) fallbackFacts.push("✅ ทานง่าย", "✅ พกติดบ้านไว้สะดวก", "✅ ปริมาณต่อขวดคุ้มค่า");
  if (/ขนม|snack|เปี๊ยะ|อาหาร/.test(haystack)) fallbackFacts.push("✅ แพ็กแบ่งกินง่าย", "✅ รสชาติกินเพลิน", "✅ ขนาดกำลังดี");
  if (/แก้ว|tumbler|ขวดน้ำ/.test(haystack)) fallbackFacts.push("✅ ความจุใช้ได้ทั้งวัน", "✅ จับถนัดมือ", "✅ พกออกไปข้างนอกสะดวก");
  return Array.from(new Set([...facts, ...fallbackFacts].filter((line) => !isBadShopeeFact(stripShopeeLeadingEmoji(line), product)))).slice(0, 4);
}

type ShopeeCaptionParts = {
  productName: string;
  hookLine: string;
  reviewLine: string;
  details: string[];
  priceLine?: string;
  ctaLine: string;
  shortLink: string;
  hashtags: string[];
};

function buildShopeeCaptionFromParts(parts: ShopeeCaptionParts) {
  const detailLines = parts.details.length ? parts.details : ["✅ ขนาดกำลังดี", "✅ หยิบใช้ง่าย", "✅ เหมาะกับมีติดบ้านไว้"];
  return [
    parts.productName,
    "",
    parts.hookLine,
    "",
    parts.reviewLine,
    "",
    "📌 จุดที่ชอบ",
    "",
    ...detailLines.flatMap((line) => [line, ""]).slice(0, -1),
    ...(parts.priceLine ? ["", parts.priceLine] : []),
    "",
    parts.ctaLine,
    "",
    parts.shortLink,
    "",
    parts.hashtags.slice(0, SHOPEE_MAX_HASHTAGS).join(" ")
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildShopeeFallbackCaption(product: ShopeeProductRecord, shopeeShortUrl: string) {
  const productName = getShopeeCaptionProductName(product.productName);
  const caption = buildShopeeCaptionFromParts({
    productName,
    hookLine: buildShopeeProductHook(product),
    reviewLine: buildShopeeUsageSituation(product),
    details: buildShopeeDetailBullets(product),
    priceLine: formatShopeePrice(product),
    ctaLine: randomText(SHOPEE_REAL_REVIEW_CTAS),
    shortLink: formatShopeeShortLinkLine(shopeeShortUrl),
    hashtags: buildRelevantShopeeHashtags(product).filter((tag) => !isShopeeProductNameDuplicateText(tag.replace(/^#/, ""), productName))
  });
  return assertValidTextEncoding(normalizeTextEncoding(caption), "Shopee fallback caption");
}

export function sanitizeShopeeCaption(caption: string, shopeeShortUrl: string, product?: ShopeeProductRecord) {
  const cleanedInput = normalizeShopeeCaptionLinkLine(caption, shopeeShortUrl);
  const cleanedCaption = removeMarketplaceMetricLines(removeHardSellPhrases(stripForbiddenAffiliateDisclosure(cleanedInput)))
    .replace(/https?:\/\/prosocial-app-theta\.vercel\.app\/\S+/gi, "")
    .replace(/https?:\/\/[^\s]*\/api\/s\/\S+/gi, "")
    .replace(/(?:━{3,}|[-=]{3,})/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const rawLines = cleanedCaption
    .replace(/https?:\/\/[^\s]+/gi, (match) => (isShopeeShortLink(match) ? shopeeShortUrl : ""))
    .replace(/หมายเหตุ[^\n]*/gi, "")
    .replace(/affiliate/gi, "")
    .split(/\r?\n/)
    .map((line) => normalizeTextEncoding(line).trim())
    .filter((line) => {
      if (!line) return false;
      if (line.includes(shopeeShortUrl)) return false;
      if (/^Shopee\s*Link\s*:/i.test(line)) return false;
      if (/^(?:📍\s*)?พิกัด/i.test(line)) return false;
      if (/^✨\s*ความรู้สึกหลังใช้/i.test(line)) return false;
      if (/^✨\s*ความรู้สึกหลังใช้งาน/i.test(line)) return false;
      if (/^📌\s*จุดเด่นที่ชอบ/i.test(line)) return false;
      if (/^📌\s*จุดที่ชอบ/i.test(line)) return false;
      if (/^🛒\s*/i.test(line)) return false;
      if (/^(?:💰\s*)?ราคา(โปร)?\s*/i.test(line)) return false;
      if (containsForbiddenShopeeGenericText(line)) return false;
      return true;
    });

  const noOldHooks = removeOldShopeeHookLines(rawLines);
  const { contentLines, hashtags } = extractHashtags(noOldHooks, product);
  const productName = getShopeeCaptionProductName(product?.productName?.trim() || contentLines[0] || TH.defaultProductName);
  const deDuplicatedContentLines = removeDuplicateShopeeProductNameLines(contentLines, productName);
  const safeHashtags = hashtags
    .filter((tag) => !isShopeeProductNameDuplicateText(tag.replace(/^#/, ""), productName))
    .slice(0, SHOPEE_MAX_HASHTAGS);
  const bodyLines = deDuplicatedContentLines
    .filter((line) => line !== productName && !isShopeeProductNameDuplicateText(line, productName) && !containsForbiddenShopeeGenericText(line))
    .slice(0, 10);
  const isBullet = (line: string) => /^[*•\-✅]/.test(line);

  const aiNarrativeLines = bodyLines.filter((line) => !isBullet(line) && !hasSoftCta(line) && !isBadShopeeFact(line, product) && !isShopeeProductNameDuplicateText(line, productName));
  const aiFeelingLine = aiNarrativeLines[0];
  const aiSituationLine = aiNarrativeLines[1];
  const reviewLine = stripShopeeLeadingEmoji(
    compactProductText(aiSituationLine || buildShopeeUsageSituation(product ?? ({ productName } as ShopeeProductRecord)), 150)
  );
  const aiBullets = bodyLines
    .map((line) => (isBullet(line) ? normalizeShopeeBullet(stripShopeeProductNameFromText(line, productName), 86, product) : ""))
    .filter((line): line is string => Boolean(line) && !isShopeeProductNameDuplicateText(line, productName));
  const fallbackBullets = product ? buildShopeeDetailBullets(product).filter((line) => !isShopeeProductNameDuplicateText(line, productName)) : [];
  const details = Array.from(new Set([...aiBullets, ...fallbackBullets]))
    .filter((line) => !isShopeeProductNameDuplicateText(line, productName) && !containsForbiddenShopeeGenericText(line))
    .slice(0, 4);
  const rawHookLine = compactProductText(aiFeelingLine || (product ? buildShopeeProductHook(product) : "ใช้แล้วชอบกว่าที่คิด 👍"), 110);
  const hookLine = isShopeeProductNameDuplicateText(rawHookLine, productName)
    ? stripShopeeProductNameFromText(rawHookLine, productName) || buildShopeeProductHook(product ?? ({ productName } as ShopeeProductRecord))
    : rawHookLine;
  const priceLine = normalizeTextEncoding(formatShopeePrice(product));
  const ctaLine = randomText(SHOPEE_REAL_REVIEW_CTAS);

  const normalizedCaption = assertValidTextEncoding(
    normalizeTextEncoding(
      buildShopeeCaptionFromParts({
        productName,
        hookLine: compactProductText(containsForbiddenShopeeGenericText(hookLine) ? buildShopeeProductHook(product ?? ({ productName } as ShopeeProductRecord)) : hookLine, 90),
        reviewLine: compactProductText(containsForbiddenShopeeGenericText(reviewLine) ? buildShopeeUsageSituation(product ?? ({ productName } as ShopeeProductRecord)) : reviewLine, 150),
        details,
        priceLine,
        ctaLine,
        shortLink: formatShopeeShortLinkLine(shopeeShortUrl),
        hashtags: safeHashtags.length ? safeHashtags : buildRelevantShopeeHashtags(product ?? ({ productName } as ShopeeProductRecord))
      })
    ),
    "Shopee caption"
  );

  if (normalizedCaption.length <= 700 && !containsForbiddenShopeeGenericText(normalizedCaption)) {
    return normalizeShopeeCaptionLinkLine(normalizedCaption, shopeeShortUrl);
  }

  const compactCaption = buildShopeeCaptionFromParts({
    productName,
    hookLine: compactProductText(hookLine, 80),
    reviewLine: compactProductText(reviewLine, 120),
    details: details.slice(0, 3).map((line) => normalizeShopeeBullet(line, 72, product)).filter(Boolean),
    priceLine,
    ctaLine,
    shortLink: formatShopeeShortLinkLine(shopeeShortUrl),
    hashtags: safeHashtags
  });
  return assertValidTextEncoding(normalizeShopeeCaptionLinkLine(compactCaption, shopeeShortUrl), "Shopee compact caption");
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

function weightedRandomProduct<T extends { score: ProductScore }>(items: T[]) {
  const total = items.reduce((sum, item) => sum + Math.max(1, item.score.productScore), 0);
  let cursor = Math.random() * total;
  for (const item of items) {
    cursor -= Math.max(1, item.score.productScore);
    if (cursor <= 0) return item;
  }
  return items[items.length - 1];
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
  const dailyLocks = process.env.AUTO_POST_NO_DUPLICATE_SAME_DAY === "false"
    ? { productIds: new Set<string>(), identities: new Set<string>(), postedDate: getBangkokPostedDate() }
    : await getShopeeProductLocksForDate(input.userId);
  const discovered = await provider.fetchProducts({
    sourceTag: input.sourceTag ?? "trending",
    keyword: input.keyword,
    category: normalizeShopeeCategory(input.category),
    limit: Math.max(20, input.pageIds.length * Math.max(5, excludedProductIds.size + 5))
  });
  await upsertShopeeProducts(discovered);

  const selected: Array<{ pageId: string; product: ShopeeProductRecord; score: ProductScore }> = [];
  const selectedProductIds = new Set<string>();
  const selectedProductIdentities = new Set<string>();
  const filteredProducts = discovered.filter((product) => {
    const productId = String(product.productId);
    const identity = getShopeeProductIdentity(product);
    if (excludedProductIds.has(productId)) return false;
    if (dailyLocks.productIds.has(productId) || dailyLocks.identities.has(identity)) return false;
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
      const productId = String(product.productId);
      const identity = getShopeeProductIdentity(product);
      if (selectedProductIds.has(productId) || selectedProductIdentities.has(identity)) continue;
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

    const eligibleScored = scored.filter((item) => item.score.productScore >= 35);
    const best = eligibleScored.length ? weightedRandomProduct(eligibleScored) : null;

    if (!best) {
      continue;
    }

    selectedProductIds.add(String(best.product.productId));
    selectedProductIdentities.add(getShopeeProductIdentity(best.product));
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
  const fallback = assertValidTextEncoding(
    normalizeTextEncoding(buildShopeeFallbackCaption(product, input.affiliateLink)),
    "Shopee fallback caption"
  );
  const captionProductName = getShopeeCaptionProductName(product.productName);
  const productFactLines = collectShopeeProductFacts(product).map((line) => stripShopeeLeadingEmoji(line));

  const customPrompt = [
    "ROLE: คุณคือ Content Creator สายรีวิวสินค้า Facebook Affiliate ที่เขียนเหมือนคนใช้งานจริง ไม่ใช่โบรชัวร์ขายสินค้า",
    "",
    "โครงสร้างบังคับ:",
    `${captionProductName}`,
    "",
    "{ฟิลลิ่งใช้งานจริง 1-2 บรรทัด ห้ามพูดชื่อสินค้าซ้ำ ห้ามใส่หัวข้อ}",
    "",
    "{สถานการณ์ใช้งานจริง 1 บรรทัด เช่น ใช้ที่บ้าน ใช้ในครัว ใช้จัดโต๊ะ ใช้พกออกไปข้างนอก ห้ามพูดชื่อสินค้าซ้ำ}",
    "",
    "📌 จุดที่ชอบ",
    "",
    "✅ {feature_1 เขียนจากมุมผู้ใช้จริง ไม่คัดลอก Shopee ตรง ๆ}",
    "",
    "✅ {feature_2 เขียนจากมุมผู้ใช้จริง ไม่คัดลอก Shopee ตรง ๆ}",
    "",
    "✅ {feature_3 ถ้ามีข้อมูลจริง}",
    "",
    "✅ {feature_4 ถ้ามีข้อมูลจริง}",
    "",
    `${formatShopeePrice(product) || priceLine}`,
    "",
    "🛒 {CTA ธรรมชาติ: ใครกำลังมองหา[ประโยชน์ของสินค้า] ลองกดดูรายละเอียดเพิ่มเติมได้เลย หรือ ผมแปะพิกัดไว้ให้แล้ว ลองเข้าไปดูรีวิวเพิ่มเติมได้ครับ}",
    "",
    `📍 พิกัด ${input.affiliateLink}`,
    "",
    "{hashtags 3-5 อัน เกี่ยวข้องกับแบรนด์ ประเภทสินค้า หมวดสินค้า หรือ Shopee เท่านั้น}",
    "",
    "กฎสำคัญ:",
    "- บรรทัดแรกต้องเป็นชื่อสินค้าเท่านั้น ห้ามมี emoji หรือคำอื่นก่อนชื่อสินค้า",
    "- Product name must appear exactly once, on the first line only.",
    "- ห้ามซ้ำชื่อสินค้าใน hook, review, bullet, CTA และ hashtag",
    "- ห้ามใช้หัวข้อ ความรู้สึกหลังใช้งาน, ความรู้สึกหลังใช้, เหตุผลที่ซื้อ, จุดเด่นที่ชอบ",
    "- หัวข้อจุดเด่นต้องเป็น: 📌 จุดที่ชอบ",
    "- CTA ต้องอยู่เหนือพิกัด และบรรทัดพิกัดต้องเป็นรูปแบบเดียวเท่านั้น: 📍 พิกัด https://s.shopee.co.th/{shortCode}",
    "- ห้ามใช้ category เป็น feature เช่น General, Lifestyle, Beauty, Home",
    "- ห้ามใช้คะแนนร้าน ยอดขาย จำนวนรีวิว bestseller ขายดีอันดับ 1",
    "- ห้ามใช้คำ generic: เลือกจากรายละเอียดสินค้าแล้วดูใช้งานได้จริง, เหมาะสำหรับผู้ใช้งานทั่วไป, เหมาะกับหมวด, เหมาะกับการใช้งานทั่วไป, คุ้มค่ากับราคา, จากข้อมูลสินค้า, จากรายละเอียดสินค้า, ใช้งานได้จริง, คุณสมบัติสินค้า, สินค้าประเภท, ลองเช็กโปรหน้าสินค้าได้เลย",
    "- ห้ามใช้คำ marketplace เช่น ร้านได้คะแนน, ยอดขาย, รีวิวจำนวน, รับประกันร้านค้า, จัดส่งเร็ว",
    "- ห้ามใช้คำว่า หมายเหตุ หรือ affiliate",
    "- ห้ามใช้ internal redirect URL",
    "- ไม่เกิน 700 ตัวอักษร อ่านง่ายบนมือถือ",
    "- UTF-8 only: ห้ามส่ง mojibake หรือ emoji เสีย",
    "",
    "Product data:",
    `ชื่อสินค้าเต็ม: ${product.productName}`,
    `ชื่อที่ใช้ขึ้นบรรทัดแรก: ${captionProductName}`,
    `หมวดหมู่ใช้เป็นบริบทเท่านั้น ห้ามแสดงเป็น feature: ${product.category || "-"}`,
    `รายละเอียดสินค้า: ${product.productDescription || "-"}`,
    `จุดเด่นที่สกัดจากข้อมูลจริง: ${productFactLines.join(" | ") || "-"}`,
    `Shopee Short Link: ${input.affiliateLink}`,
    "",
    "Return caption only inside JSON variants[].caption."
  ].join("\n");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
    const variants = await generateFacebookContent(captionProductName, {
      userId: input.userId,
      customPrompt: normalizeTextEncoding(customPrompt),
      sourceLabel: "Shopee product facts for UGC review caption",
      sourceText: normalizeTextEncoding([
        `Product name: ${captionProductName}`,
        `Full product name: ${product.productName}`,
        `Description: ${product.productDescription}`,
        `Extracted facts: ${productFactLines.join(" | ")}`,
        priceLine,
        `Shopee short link: ${input.affiliateLink}`
      ].join("\n"))
    });
    const chosen = variants?.length ? randomItem(variants) : null;
    if (!chosen?.caption) return fallback;
    const generatedCaption = normalizeTextEncoding(chosen.caption);
    const withLink = generatedCaption.includes(input.affiliateLink)
      ? generatedCaption
      : `${generatedCaption.trim()}\n${input.affiliateLink}`;
    const sanitized = sanitizeShopeeCaption(withLink, input.affiliateLink, product);
    const validation = validateTextEncoding(sanitized, "Shopee AI caption");
    if (!validation.ok) {
      console.warn("[Encoding Error Detected] Caption regenerated", {
        attempt,
        markers: validation.markers,
        preview: validation.preview
      });
      if (attempt < 3) continue;
      return fallback;
    }
    return sanitized.length > input.affiliateLink.length + 20 ? sanitized : fallback;
    } catch (error) {
      const validation = validateTextEncoding(String(error instanceof Error ? error.message : error), "Shopee caption generation error");
      if (!validation.ok && attempt < 3) {
        console.warn("[Encoding Error Detected] Caption regenerated", {
          attempt,
          markers: validation.markers
        });
        continue;
      }
      return fallback;
    }
  }

  return fallback;
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
  jobId?: string;
}) {
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

