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

const SHOPEE_CONTEXTLESS_GENERIC_PHRASES = [
  "ใช้งานได้ดี",
  "สะดวก",
  "คุ้มค่า",
  "เลือกได้ง่าย",
  "เหมาะกับการใช้งาน"
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
  "ใส่สบายทั้งวัน",
  "คุณสมบัติสินค้า",
  "สินค้าประเภท",
  "วิเคราะห์จากรูป",
  "วิเคราะห์จากชื่อสินค้า",
  "ดูจากข้อมูล",
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

function getShopeeProductSourceEvidence(product: ShopeeProductRecord, pattern: RegExp) {
  const sourceTexts = getShopeeProductSourceTexts(product);
  const title = pattern.test(sourceTexts.title.toLowerCase());
  const description = pattern.test(sourceTexts.description.toLowerCase());
  const category = pattern.test(sourceTexts.category.toLowerCase());
  const imageTextMatch = pattern.test(sourceTexts.images.toLowerCase());
  const hasImage = Boolean(product.productImageUrl || product.productImageUrls?.length);
  const images = imageTextMatch || (hasImage && (title || description));
  const sourceMatches = { images, title, description, category };
  const sourceMatchCount = Object.values(sourceMatches).filter(Boolean).length;
  const confidence: ShopeeProductInsight["confidence"] =
    sourceMatchCount >= 4 ? "high" : sourceMatchCount >= 3 ? "medium" : "low";
  return { sourceMatches, sourceMatchCount, confidence };
}

function withShopeeProductEvidence(
  product: ShopeeProductRecord,
  insight: ShopeeProductInsight,
  pattern: RegExp
): ShopeeProductInsight {
  const evidence = getShopeeProductSourceEvidence(product, pattern);
  return {
    ...insight,
    recognized: insight.recognized && evidence.sourceMatchCount >= 2,
    confidence: evidence.confidence,
    sourceMatches: evidence.sourceMatches,
    sourceMatchCount: evidence.sourceMatchCount,
    safeCaptionMode: evidence.sourceMatchCount === 2,
    skipReason: evidence.sourceMatchCount < 2 ? "SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT: product context too weak" : undefined
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

  if (/บ้าน|home|จัดระเบียบ|เก็บของ|ทำความสะอาด|ไม้ถู|ถังขยะ|ชั้นวาง|กล่องเก็บ|ซักผ้า|น้ำยาซัก|ปรับผ้านุ่ม|detergent|laundry/.test(haystack)) {
    return withShopeeProductEvidence(product, {
      type: "ของใช้ในบ้าน",
      recognized: true,
      productCategory: "home_living",
      audience: "คนที่อยากจัดบ้าน ทำความสะอาด หรือแก้ปัญหาของใช้จุกจิกในบ้าน",
      situation: "ใช้ในบ้าน ห้องน้ำ ห้องครัว มุมซักผ้า หรือมุมจัดเก็บของ",
      problem: "ช่วยให้บ้านเป็นระเบียบ สะอาด หรือหยิบใช้งานได้สะดวกขึ้น",
      angle: "เน้นการใช้งานจริง ความสะดวก การจัดระเบียบ การทำความสะอาด และปัญหาในบ้าน",
      fallbackFeatures: ["✅ ช่วยให้บ้านเป็นระเบียบขึ้น", "✅ ใช้งานในบ้านได้สะดวก", "✅ เหมาะกับมุมที่ต้องหยิบใช้บ่อย", "✅ ช่วยประหยัดพื้นที่หรือเวลา"],
      forbiddenAngles: []
    }, /บ้าน|home|จัดระเบียบ|เก็บของ|ทำความสะอาด|ไม้ถู|ถังขยะ|ชั้นวาง|กล่องเก็บ|ซักผ้า|น้ำยาซัก|ปรับผ้านุ่ม|detergent|laundry|fineline/i);
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
    recognized: false,
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
    safeCaptionMode: true,
    skipReason: genericInsight.sourceMatchCount && genericInsight.sourceMatchCount >= 2
      ? undefined
      : "SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT: product context too weak"
  };
}

function assertRecognizedShopeeProductInsight(product: ShopeeProductRecord) {
  return getShopeeProductInsight(product);
}

export function getShopeeCaptionProductName(productName?: string) {
  const cleaned = normalizeTextEncoding(productName ?? "")
    .replace(/^\s*\[[^\]]*(?:แถม|โปร|ลด|ส่งฟรี|sale|deal)[^\]]*\]\s*/giu, "")
    .replace(/^\s*(?:แถม|โปร|ลด|ส่งฟรี|sale|deal)\s*[:：-]?\s*/giu, "")
    .replace(/\s+/g, " ")
    .trim();
  return getShopeeShortReviewProductName(cleaned || productName || TH.defaultProductName);
}

function getShopeeShortReviewProductName(productName?: string) {
  const source = normalizeTextEncoding(productName ?? TH.defaultProductName)
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
    [/ต่างหู|earring/iu, () => /โบฮีเมียน|boho|bohemian/.test(haystack) ? "ต่างหูโบฮีเมียนแต่งลาย ✨" : "ต่างหูแฟชั่นสไตล์วินเทจ ✨"],
    [/พัดลมพกพา|fan/iu, () => "พัดลมพกพาชาร์จ USB 🌀"],
    [/สมาร์ทวอทช์|smart\s*watch|watch/iu, () => /awei/.test(haystack) ? "สมาร์ทวอทช์ฟังก์ชันครบ Awei ⌚" : "สมาร์ทวอทช์ฟังก์ชันครบ ⌚"],
    [/เวย์โปรตีน|whey|protein/iu, () => "เวย์โปรตีนชงดื่มหลังออกกำลังกาย 💚"],
    [/ไหมขัดฟัน|floss/iu, () => "ไหมขัดฟันด้ามจับใช้ง่าย 🦷"],
    [/น้ำยาซักผ้า|detergent|laundry/iu, () => "น้ำยาซักผ้ากลิ่นหอมติดบ้าน 🏠"],
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

function getShopeeCaptionTitleRepeatTerms(captionProductName?: string, fullProductName?: string) {
  const combined = normalizeTextEncoding(`${captionProductName || ""} ${fullProductName || ""}`).toLowerCase();
  const normalizedCombined = normalizeProductNameText(combined);
  const explicitTerms = [
    "รองเท้าวิ่ง",
    "รองเท้ากีฬา",
    "รองเท้า",
    "ถุงเท้ากีฬา",
    "ถุงเท้า",
    "แก้วเก็บความเย็น",
    "แก้วเก็บอุณหภูมิ",
    "แก้วน้ำ",
    "กระติกน้ำ",
    "โคมไฟ",
    "สมาร์ทวอทช์",
    "เวย์โปรตีน",
    "ไหมขัดฟัน",
    "น้ำยาซักผ้า",
    "เซรั่ม",
    "กันแดด",
    "กระเป๋าคาดอก",
    "กระเป๋า",
    "หูฟัง",
    "กล่องสุ่ม",
    "art toy",
    "ฟิกเกอร์",
    "ขนมเปี๊ยะ"
  ].filter((term) => combined.includes(term.toLowerCase()));
  const brandModelTerms = normalizedCombined
    .split(/\s+/)
    .filter((token) =>
      token.length >= 3 &&
      !/^(?:the|and|for|with|official|shop|store|free|sale|deal|new|แท้|ของแท้|ส่งฟรี|พร้อมส่ง|รุ่น|ใหม่|ล่าสุด|สำหรับ|พร้อม|ขนาด|สี|แพ็ก|เซ็ต)$/i.test(token) &&
      !isGenericShopeeCategoryText(token)
    )
    .filter((token) => /[a-z]/i.test(token) || /\d/.test(token));
  return Array.from(new Set([...explicitTerms, ...brandModelTerms])).sort((a, b) => b.length - a.length);
}

function containsShopeeCaptionTitleRepeat(line: string, captionProductName?: string, fullProductName?: string) {
  const normalizedLine = normalizeProductNameText(line);
  if (!normalizedLine) return false;
  if (isSimilarToShopeeProductName(line, captionProductName, 0.45)) return true;
  if (isSimilarToShopeeProductName(line, fullProductName, 0.45)) return true;
  const terms = getShopeeCaptionTitleRepeatTerms(captionProductName, fullProductName);
  return terms.some((term) => {
    const normalizedTerm = normalizeProductNameText(term);
    if (!normalizedTerm || normalizedTerm.length < 3) return false;
    return normalizedLine.includes(normalizedTerm);
  });
}

function stripShopeeCaptionTitleRepeatTerms(line: string, captionProductName?: string, fullProductName?: string) {
  let cleaned = line.trim();
  for (const term of getShopeeCaptionTitleRepeatTerms(captionProductName, fullProductName)) {
    if (!term.trim()) continue;
    cleaned = cleaned.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  }
  cleaned = removeShopeeProductNameFromText(cleaned, captionProductName);
  cleaned = removeShopeeProductNameFromText(cleaned, fullProductName);
  return cleaned
    .replace(/\b(?:รุ่นนี้|ตัวนี้|ใบนี้|คู่นี้|อันนี้)\b/giu, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:ï¼š,\-â€“â€”|/]+|[\s:ï¼š,\-â€“â€”|/]+$/g, "")
    .trim();
}

function enforceShopeeCaptionTitleOnce(caption: string, captionProductName?: string, fullProductName?: string) {
  const lines = caption.split(/\r?\n/);
  if (!lines.length) return caption.trim();
  const firstLine = lines[0]?.trim() || compactProductText(captionProductName || fullProductName || TH.defaultProductName, 58);
  const rest = lines.slice(1).map((line) => {
    if (!line.trim()) return line;
    if (/^(?:💰|🛒|📍|#)/u.test(line.trim())) return line;
    if (!containsShopeeCaptionTitleRepeat(line, firstLine, fullProductName)) return line;
    const cleaned = stripShopeeCaptionTitleRepeatTerms(line, firstLine, fullProductName);
    return cleaned.length >= 10 ? cleaned : "";
  });
  return [firstLine, ...rest]
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
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
    if (/ซักผ้า|น้ำยาซัก|ปรับผ้านุ่ม|detergent|laundry|fineline/.test(haystack)) return ["เหมาะกับบ้านที่ซักผ้าบ่อยและอยากมีผลิตภัณฑ์ซักผ้าติดไว้", "แพ็กและปริมาณช่วยให้จัดรอบซักผ้าที่บ้านได้สะดวกขึ้น"];
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
    if (/ซักผ้า|น้ำยาซัก|ปรับผ้านุ่ม|detergent|laundry|fineline/.test(haystack)) return ["ซื้อไว้ใช้ซักผ้าที่บ้าน รอบซักบ่อย ๆ จะรู้สึกว่ามีติดไว้แล้วสะดวก"];
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
  if (/ซักผ้า|น้ำยาซัก|detergent|laundry|fineline/.test(haystack)) fallbackFacts.push("✅ กลิ่นหอมกำลังดี", "✅ ปริมาณเยอะ ใช้ได้นาน", "✅ เหมาะกับบ้านที่ซักผ้าบ่อย");
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
  if (/ซักผ้า|น้ำยาซัก|จัดระเบียบ|บ้าน|home|detergent|laundry/.test(haystack)) return "🏠";
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
    if (/ซักผ้า|น้ำยาซัก|detergent|laundry|fineline/.test(haystack)) {
      return ["มีติดบ้านไว้แล้วสะดวกกับรอบซักผ้าบ่อย ๆ ใช้งานง่ายและเก็บเข้ามุมได้ดี", "เหมาะกับบ้านที่ซักผ้าเป็นประจำ หยิบใช้ได้เรื่อย ๆ ไม่ต้องคอยซื้อบ่อย"];
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

export function buildShopeeFallbackCaption(product: ShopeeProductRecord, shopeeShortUrl: string) {
  assertRecognizedShopeeProductInsight(product);
  const productName = getShopeeCaptionProductName(product.productName);
  const caption = enforceShopeeCaptionTitleOnce(buildShopeeCaptionFromParts({
    productName,
    reviewLine: buildShopeeShortReviewLine(product),
    priceLine: formatShopeePrice(product),
    ctaLine: randomText(SHOPEE_REAL_REVIEW_CTAS),
    shortLink: formatShopeeShortLinkLine(shopeeShortUrl),
    hashtags: buildRelevantShopeeHashtags(product).filter((tag) => !isShopeeProductNameDuplicateText(tag.replace(/^#/, ""), productName))
  }), productName, product.productName);
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
      if (containsForbiddenShopeeGenericText(line, product)) return false;
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
    .filter((line) => line !== productName && !isShopeeProductNameDuplicateText(line, productName) && !containsForbiddenShopeeGenericText(line, product))
    .slice(0, 10);
  const reviewLine = extractShopeeShortReviewLine(bodyLines, product)
    || (product ? buildShopeeShortReviewLine(product) : "✨ อ่านง่าย ใช้งานตามบริบทสินค้าได้สะดวก");
  const safeReviewLine = product
    ? sanitizeShopeeHealthCaptionText(
        enforceShopeeCaptionTitleOnce(`${productName}\n${reviewLine}`, productName, product.productName).split(/\r?\n/).slice(1).join(" ").trim(),
        product
      ) || buildShopeeShortReviewLine(product)
    : reviewLine;
  const priceLine = normalizeTextEncoding(formatShopeePrice(product));
  const ctaLine = randomText(SHOPEE_REAL_REVIEW_CTAS);

  const normalizedCaption = assertValidTextEncoding(
    normalizeTextEncoding(
      enforceShopeeCaptionTitleOnce(buildShopeeCaptionFromParts({
        productName,
        reviewLine: safeReviewLine,
        priceLine,
        ctaLine,
        shortLink: formatShopeeShortLinkLine(shopeeShortUrl),
        hashtags: safeHashtags.length ? safeHashtags : buildRelevantShopeeHashtags(product ?? ({ productName } as ShopeeProductRecord))
      }), productName, product?.productName)
    ),
    "Shopee caption"
  );

  if (
    normalizedCaption.length <= 700 &&
    !containsForbiddenShopeeGenericText(normalizedCaption, product) &&
    !hasShopeeHealthForbiddenSnackText(normalizedCaption, product)
  ) {
    return normalizeShopeeCaptionLinkLine(normalizedCaption, shopeeShortUrl);
  }

  const compactCaption = buildShopeeCaptionFromParts({
    productName,
    reviewLine: compactProductText(safeReviewLine, 120),
    priceLine,
    ctaLine,
    shortLink: formatShopeeShortLinkLine(shopeeShortUrl),
    hashtags: safeHashtags
  });
  return assertValidTextEncoding(
    normalizeShopeeCaptionLinkLine(enforceShopeeCaptionTitleOnce(compactCaption, productName, product?.productName), shopeeShortUrl),
    "Shopee compact caption"
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
  const productInsight = assertRecognizedShopeeProductInsight(product);
  if ((productInsight.sourceMatchCount ?? 0) < 2) {
    throw new ShopeeProviderError(
      `caption generation failed: SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT product context too weak for ${product.productId}`,
      422,
      "product_context_too_weak",
      "internal_api"
    );
  }
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
  const insightFeatureLines = productFactLines.length
    ? productFactLines
    : productInsight.fallbackFeatures.map((line) => stripShopeeLeadingEmoji(line));
  const sourceMatches = productInsight.sourceMatches ?? { images: false, title: false, description: false, category: false };
  const captionMode = productInsight.safeCaptionMode ? "LOW_CONFIDENCE_USE_SAFE_CAPTION" : "NORMAL_CAPTION";
  const healthSafetyMode = isShopeeHealthSensitiveProduct(product) ? "HEALTH_PRODUCT_SAFETY_GUARD" : "STANDARD_PRODUCT";

  const customPrompt = [
    "ROLE: คุณคือ Content Creator สายรีวิวสินค้า Facebook Affiliate ที่เขียนแบบสั้น กระชับ เหมือนเพจรีวิวสินค้าใช้งานจริง",
    "",
    "ขอบเขตสำคัญ:",
    "- ปรับเฉพาะวิธีเขียน caption เท่านั้น",
    "- เขียนสั้น อ่านง่ายบนมือถือ ไม่เป็นโบรชัวร์ ไม่เป็นสเปกสินค้า",
    "- ห้ามอ้างประสบการณ์ส่วนตัวปลอม เช่น ผมใช้เอง ลองแล้วชอบ ใช้แล้วติดใจ",
    "- ห้ามเดาคุณสมบัติใหม่ ห้ามคัดลอกชื่อสินค้ามาวนซ้ำ",
    "- ห้ามสร้าง bullet point, checklist, feature list หรือหัวข้อ 📌 จุดที่ชอบ",
    "",
    "ก่อนเขียนให้วิเคราะห์สินค้าแบบเงียบ ๆ ตาม Priority Sources นี้เท่านั้น:",
    "1) Product Images เป็นหลัก",
    "2) Product Title",
    "3) Product Description",
    "4) Product Category ใช้เป็นบริบทสุดท้าย ห้ามนำมาเขียนเป็น feature",
    "",
    "Product understanding ที่ระบบวิเคราะห์ไว้:",
    `- Product type: ${productInsight.type}`,
    `- Confidence: ${productInsight.confidence ?? "low"} (${captionMode})`,
    `- Source matches: images=${sourceMatches.images ? "yes" : "no"}, title=${sourceMatches.title ? "yes" : "no"}, description=${sourceMatches.description ? "yes" : "no"}, category=${sourceMatches.category ? "yes" : "no"}`,
    `- สินค้านี้ใช้ทำอะไร: ${productInsight.situation}`,
    `- คนซื้อใช้ในสถานการณ์ไหน: ${productInsight.problem}`,
    `- จุดเด่นที่สัมผัสได้จริง: ${insightFeatureLines.join(" | ") || productInsight.angle}`,
    `- เหมาะกับใคร: ${productInsight.audience}`,
    `- ประโยชน์หลัก: ${productInsight.angle}`,
    "",
    productInsight.safeCaptionMode
      ? "SAFE CAPTION MODE: เขียนจากสิ่งที่ชัดเจนที่สุดเพียง 1 บรรทัด ห้ามเดาจุดเด่นเพิ่ม ห้ามใช้ claims ที่ไม่มีในชื่อ/รูป/description"
      : "NORMAL CAPTION MODE: เขียนรีวิวสั้นที่สัมพันธ์กับประเภทสินค้าและการใช้งานจริงโดยตรง",
    isShopeeHealthSensitiveProduct(product)
      ? "HEALTH PRODUCT SAFETY GUARD: สินค้านี้เป็นอาหารเสริม/วิตามิน/ผลิตภัณฑ์สุขภาพ/เครื่องสำอาง/เวชสำอาง ห้ามใช้คำว่า กินเล่น, ของกินเล่น, ขนม, ของว่าง, กินเพลิน, เคี้ยวเพลิน, ทานเล่น และห้ามทำให้ดูเป็นขนมหรืออาหารทั่วไป ให้ใช้คำว่า อาหารเสริม, วิตามิน, ผลิตภัณฑ์ดูแลสุขภาพ, สูตรที่เลือกใช้ตามความต้องการ, พกพาสะดวก, ขนาดกำลังดี แทน"
      : "STANDARD PRODUCT SAFETY: เขียนตามประเภทสินค้าโดยไม่ใช้คำเกินจริง",
    "",
    "โครงสร้างบังคับ ห้ามเปลี่ยนลำดับ:",
    `${captionProductName}`,
    "",
    "{รีวิวสั้น 1-2 บรรทัด พร้อม emoji ที่ตรงกับประเภทสินค้า เช่น 🥤 💡 🏃 🚗 🍳 📱 💚 ✨}",
    "",
    `${formatShopeePrice(product) || priceLine}`,
    "",
    "🛒 กดดูรายละเอียดเพิ่มเติม",
    "",
    `📍 พิกัด ${input.affiliateLink}`,
    "",
    "{hashtags 3-5 อัน เกี่ยวข้องกับแบรนด์ ประเภทสินค้า หมวดสินค้า หรือ Shopee เท่านั้น}",
    "",
    "กฎ output:",
    "- บรรทัดแรกต้องเป็นชื่อสินค้าสั้น ๆ เท่านั้น ห้ามมี emoji หรือคำอื่นก่อนชื่อสินค้า",
    "- Product name must appear exactly once, on the first line only.",
    "- หลังบรรทัดแรก ห้ามซ้ำชื่อสินค้าเดิมอีกทั้งหมด รวมถึงชื่อเต็ม ชื่อย่อ ชื่อแบรนด์+รุ่น หรือคำที่เหมือนชื่อสินค้า",
    "- ตัวอย่างห้าม: ถ้าบรรทัดแรกเป็น รองเท้าวิ่งน้ำหนักเบา Adidas 👟 ห้ามเขียน รองเท้า Adidas รุ่นนี้ หรือ Adidas Adizero ในบรรทัดถัดไป",
    "- ตัวอย่างห้าม: ถ้าบรรทัดแรกเป็น แก้วเก็บความเย็นพกพา 🥤 ห้ามเขียน แก้วเก็บความเย็นใบนี้ หรือ กระติกน้ำรุ่นนี้ ในบรรทัดถัดไป",
    "- ห้ามซ้ำชื่อสินค้าในรีวิว CTA หรือ hashtag",
    "- รีวิวสั้นต้องไม่เกิน 2 บรรทัด และต้องเป็นประโยชน์จากการใช้งาน ไม่ใช่สเปกดิบ",
    "- ห้ามใช้ ✅, *, -, bullet, checklist, feature list, หรือหัวข้อ 📌 จุดที่ชอบ",
    "- ห้ามใช้ภาษาทางเทคนิคหรือสรุปสเปก เช่น ความจุ 950ml, ผลิตจากสแตนเลส 304, ปรับได้ 5 ระดับ",
    "- ถ้าจำเป็นต้องพูดถึงสเปก ให้แปลงเป็นประโยชน์ เช่น เติมน้ำไว้จิบระหว่างวันได้ง่าย หรือปรับแสงให้เหมาะกับอ่านหนังสือ",
    "- CTA ต้องอยู่เหนือพิกัด และบรรทัดพิกัดต้องเป็นรูปแบบเดียวเท่านั้น: 📍 พิกัด https://s.shopee.co.th/{shortCode}",
    "- ห้ามใช้ category เป็น feature เช่น General, Lifestyle, Beauty, Home",
    "- ห้ามเขียนหลุดประเภทสินค้า เช่น รองเท้าไปเขียนเรื่องจัดบ้าน, แก้วน้ำไปเขียนเรื่องวิ่ง, เครื่องสำอางไปเขียนเรื่องจัดโต๊ะ",
    "- ถ้าสินค้าเป็นกลุ่มอาหารเสริม วิตามิน ผลิตภัณฑ์สุขภาพ เครื่องสำอาง หรือเวชสำอาง ห้ามใช้คำว่า กินเล่น, ขนม, ของว่าง, กินเพลิน, เคี้ยวเพลิน, ทานเล่น",
    "- ห้ามใช้คะแนนร้าน ยอดขาย จำนวนรีวิว bestseller ขายดีอันดับ 1",
    "- ห้ามใช้คำ generic หรือภาษาระบบ: เลือกจากรายละเอียดสินค้าแล้วดูใช้งานได้จริง, ดูจากรายละเอียดสินค้า, จากข้อมูลที่ระบุ, จากคำอธิบายสินค้า, ตามข้อมูล, ตามรายละเอียดที่ระบุ, เลือกดูจากชื่อสินค้า, เลือกดูจากรายละเอียดสินค้า, ตามสเปกที่แจ้งไว้, ตามข้อมูลผู้ขาย, จากรูปแบบสินค้า, รูปแบบที่เห็นในภาพ, จากรูปภาพสินค้า, จากภาพสินค้า, อ่านรายละเอียดก่อนเลือกซื้อ, เลือกจากรุ่น สี ขนาด หรือแพ็กที่ระบุไว้, เหมาะสำหรับผู้ใช้งานทั่วไป, เหมาะกับหมวด, เหมาะกับการใช้งานทั่วไป, คุ้มค่ากับราคา, จากข้อมูลสินค้า, จากรายละเอียดสินค้า, ใช้งานได้จริง, คุณสมบัติสินค้า, สินค้าประเภท, ลองเช็กโปรหน้าสินค้าได้เลย",
    "- ห้ามพูดถึงกระบวนการวิเคราะห์ เช่น วิเคราะห์จากรูป, วิเคราะห์จากชื่อสินค้า, ดูจากข้อมูล, ตรวจสเปก, ตรวจรายละเอียด",
    "- ห้ามใช้คำ marketplace เช่น ร้านได้คะแนน, ยอดขาย, รีวิวจำนวน, รับประกันร้านค้า, จัดส่งเร็ว",
    "- ห้ามใช้คำว่า หมายเหตุ หรือ affiliate",
    "- ห้ามใช้ internal redirect URL",
    "- ไม่เกิน 700 ตัวอักษร",
    "- UTF-8 only: ห้ามส่ง mojibake หรือ emoji เสีย",
    "",
    "Product data:",
    `ชื่อสินค้าเต็ม: ${product.productName}`,
    `ชื่อที่ใช้ขึ้นบรรทัดแรก: ${captionProductName}`,
    `หมวดหมู่ใช้เป็นบริบทเท่านั้น ห้ามแสดงเป็น feature: ${product.category || "-"}`,
    `รายละเอียดสินค้า: ${product.productDescription || "-"}`,
    `รูปภาพสินค้าเพื่อช่วยระบุประเภท: ${(product.productImageUrls?.length ? product.productImageUrls : [product.productImageUrl]).filter(Boolean).slice(0, 4).join(" | ") || "-"}`,
    `Product insight type: ${productInsight.type}`,
    `Product insight confidence: ${productInsight.confidence ?? (productInsight.recognized ? "high" : "low")}`,
    `Source match count: ${productInsight.sourceMatchCount ?? 0}/4`,
    `Source matches: ${JSON.stringify(sourceMatches)}`,
    `Caption mode: ${captionMode}`,
    `Health safety mode: ${healthSafetyMode}`,
    `Target audience: ${productInsight.audience}`,
    `Usage situation: ${productInsight.situation}`,
    `Problem solved: ${productInsight.problem}`,
    `Content angle: ${productInsight.angle}`,
    `จุดเด่นที่สกัดจากข้อมูลจริง: ${productFactLines.join(" | ") || "-"}`,
    `มุมที่ห้ามใช้: ${productInsight.forbiddenAngles.join(" | ") || "-"}`,
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
        `Priority source 1 - Product images: ${(product.productImageUrls?.length ? product.productImageUrls : [product.productImageUrl]).filter(Boolean).slice(0, 4).join(" | ") || "-"}`,
        `Priority source 2 - Product title: ${product.productName}`,
        `Priority source 3 - Product description: ${product.productDescription || "-"}`,
        `Priority source 4 - Product category: ${product.category || "-"}`,
        `Description: ${product.productDescription}`,
        `Product insight: ${productInsight.type}; confidence=${productInsight.confidence}; mode=${captionMode}; healthSafety=${healthSafetyMode}; matches=${JSON.stringify(sourceMatches)}; ${productInsight.audience}; ${productInsight.situation}; ${productInsight.problem}; ${productInsight.angle}`,
        `Extracted facts: ${productFactLines.join(" | ")}`,
        `Fallback category features if facts are limited: ${productInsight.fallbackFeatures.join(" | ")}`,
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


