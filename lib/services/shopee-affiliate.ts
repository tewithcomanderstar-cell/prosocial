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
  categories?: string[];
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
        endpointHost: url.host,
        endpointPath: url.pathname,
        graphqlErrors: summary
      }
    });
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

function getShopeeStoryboardInputText(product: ShopeeProductRecord) {
  const record = product as ShopeeProductRecord & Record<string, unknown>;
  const metadata = ["productFeatures", "features", "specifications", "specs", "attributes", "variants"]
    .flatMap((key) => stringifyShopeeMetadataValue(record[key]))
    .join(" ");
  return normalizeTextEncoding([
    getShopeeProductImageSourceText(product),
    product.productName,
    product.productDescription,
    metadata
  ].filter(Boolean).join(" ")).toLowerCase();
}

function getShopeeStoryboardEmoji(productType: string) {
  if (/ลูกแบด|แบดมินตัน/.test(productType)) return "🏸";
  if (/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|บันทึกภาพรถ/i.test(productType)) return "🚗";
  if (/กล้อง|camera|แอคชั่น/i.test(productType)) return "📷";
  if (/อาหารเสริม|วิตามิน|เวย์|โปรตีน/.test(productType)) return "💚";
  if (/เก้าอี้/.test(productType)) return "🪑";
  if (/รองเท้า/.test(productType)) return "👟";
  if (/ถุงเท้า|กีฬา|วิ่ง|ฟิตเนส/.test(productType)) return "🏃";
  if (/แก้ว|กระติก|ขวดน้ำ/.test(productType)) return "🥤";
  if (/โคมไฟ|ไฟ/.test(productType)) return "💡";
  if (/หูฟัง|มือถือ|แกดเจ็ต|สมาร์ทวอทช์/.test(productType)) return "📱";
  if (/สกินแคร์|เซรั่ม|กันแดด|ผิว/.test(productType)) return "✨";
  if (/กระเป๋า/.test(productType)) return "🎒";
  if (/รถ|จัมป์สตาร์ท|ยาง/.test(productType)) return "🚗";
  if (/อาหาร|ขนม|น้ำพริก|ครัว/.test(productType)) return "🍳";
  if (/สัตว์/.test(productType)) return "🐾";
  if (/อาร์ตทอย|กล่องสุ่ม|ของสะสม|ฟิกเกอร์/.test(productType)) return "🎁";
  return "✨";
}

function buildShopeeStoryboardName(fallback: string, emoji: string, product?: ShopeeProductRecord) {
  const name = getShopeeCaptionProductName(product?.productName || fallback)
    .replace(/\s+[✨🔥😍😋💯👍🎯🛒💥⭐📌📍🥤☕🧊💡🏠🏃⚽🎾🚗🍳📱💻💚💖👟📷⌚🎒🏸🦷🌀]+$/u, "")
    .trim();
  const safeName = name.length >= 8 && !/^(?:สินค้า|ไอเทม|ของใช้ทั่วไป)$/iu.test(name) ? name : fallback;
  return compactProductText(`${safeName} ${emoji}`.trim(), 64);
}

function makeShopeeStoryboard(
  product: ShopeeProductRecord,
  input: Omit<
    ShopeeProductStoryboard,
    | "productSimpleName"
    | "problemSolved"
    | "dailyBenefit"
    | "emotionalBenefit"
    | "realUsageScenario"
    | "purchaseReason"
    | "primaryPainPoint"
  >
): ShopeeProductStoryboard {
  const base = {
    productSimpleName: buildShopeeStoryboardName(input.productType, getShopeeStoryboardEmoji(input.productType), product),
    ...input
  };
  return enrichShopeeStoryboardForAffiliateReview(base);
}

function getShopeeStoryboardProductGroup(storyboard: Pick<ShopeeProductStoryboard, "productType" | "mainUseCase" | "usageScene">) {
  const haystack = `${storyboard.productType} ${storyboard.mainUseCase} ${storyboard.usageScene}`;
  if (/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|car\s?camera|บันทึกภาพรถ/i.test(haystack)) return "dashcam";
  if (/รถ|จัมป์|จั๊ม|ยาง|สตาร์ท|แบต/i.test(haystack)) return "automotive";
  if (/ลูกแบด|แบด|กีฬา|วิ่ง|ฟิตเนส|รองเท้า|ถุงเท้า/i.test(haystack)) return "sports";
  if (/อาหาร|ขนม|น้ำพริก|กาแฟ|ชา|เครื่องดื่ม/i.test(haystack) && !/อาหารเสริม|วิตามิน|เวย์|โปรตีน/i.test(haystack)) return "food";
  if (/สกินแคร์|เซรั่ม|กันแดด|ผิว|เครื่องสำอาง|เวชสำอาง/i.test(haystack)) return "beauty";
  if (/กล้อง|มือถือ|หูฟัง|สมาร์ทวอทช์|แกดเจ็ต|ลำโพง/i.test(haystack)) return "electronics";
  if (/ครัว|แก้ว|กระติก|ขวดน้ำ|ถาดน้ำแข็ง|หม้อ|กระทะ/i.test(haystack)) return "kitchen";
  if (/กระเป๋า|เดินทาง|แคมป์|เที่ยว/i.test(haystack)) return "travel";
  return "home";
}

function enrichShopeeStoryboardForAffiliateReview(
  storyboard: Omit<
    ShopeeProductStoryboard,
    "problemSolved" | "dailyBenefit" | "emotionalBenefit" | "realUsageScenario" | "purchaseReason" | "primaryPainPoint"
  >
): ShopeeProductStoryboard {
  const group = getShopeeStoryboardProductGroup(storyboard);
  const templates: Record<string, Pick<ShopeeProductStoryboard, "primaryPainPoint" | "problemSolved" | "dailyBenefit" | "emotionalBenefit" | "purchaseReason">> = {
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
      dailyBenefit: "หยิบใช้ตอนเดินทางหรือจอดรถไว้นานได้ง่ายขึ้น",
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
      primaryPainPoint: "อยากมีของกินติดบ้านที่หยิบง่าย",
      problemSolved: "ช่วยให้มีของกินพร้อมแบ่งหรือหยิบใช้กับมื้ออาหาร",
      dailyBenefit: "เก็บไว้ในครัวหรือโต๊ะอาหารแล้วหยิบใช้ง่าย",
      emotionalBenefit: "มีติดบ้านไว้แล้วสะดวกกว่าเวลาอยากกิน",
      purchaseReason: "น่าลองสำหรับคนที่อยากมีของกินติดบ้าน"
    },
    beauty: {
      primaryPainPoint: "อยากดูแลตัวเองให้สะดวกใน routine เดิม",
      problemSolved: "ช่วยให้ขั้นตอนดูแลผิวหรือความงามง่ายขึ้น",
      dailyBenefit: "หยิบใช้ใน routine ประจำวันได้ไม่ยุ่งยาก",
      emotionalBenefit: "เพิ่มความมั่นใจในวันที่ต้องออกไปข้างนอก",
      purchaseReason: "เหมาะกับคนที่อยากมีไอเทมดูแลตัวเองไว้ใช้ประจำ"
    },
    electronics: {
      primaryPainPoint: "อยากใช้งานหรือทำคอนเทนต์ให้สะดวกขึ้น",
      problemSolved: "ช่วยให้ใช้งานกับมือถือ เดินทาง หรือทำคอนเทนต์ได้ง่าย",
      dailyBenefit: "พกหรือหยิบใช้ระหว่างวันได้สะดวก",
      emotionalBenefit: "ทำให้กิจกรรมประจำวันสนุกและคล่องตัวขึ้น",
      purchaseReason: "คุ้มสำหรับคนที่ใช้งานจริงและอยากได้ตัวช่วยที่พกง่าย"
    },
    kitchen: {
      primaryPainPoint: "มุมครัวหรือเครื่องดื่มระหว่างวันยังไม่สะดวก",
      problemSolved: "ช่วยให้การเตรียมของในครัวหรือพกเครื่องดื่มง่ายขึ้น",
      dailyBenefit: "หยิบใช้ตอนทำอาหาร จัดเก็บ หรือดื่มระหว่างวันได้สะดวก",
      emotionalBenefit: "ทำให้กิจวัตรในบ้านดูเป็นระเบียบและง่ายขึ้น",
      purchaseReason: "ของมันต้องมีสำหรับบ้านที่ใช้งานครัวหรือพกเครื่องดื่มบ่อย"
    },
    travel: {
      primaryPainPoint: "ออกไปข้างนอกแล้วของจุกจิกจัดการยาก",
      problemSolved: "ช่วยให้พกของหรือใช้งานระหว่างเดินทางคล่องตัวขึ้น",
      dailyBenefit: "ใช้ตอนเดินทาง ทำงาน หรือออกนอกบ้านได้สะดวก",
      emotionalBenefit: "พกไว้แล้วรู้สึกพร้อมกว่าเดิม",
      purchaseReason: "เหมาะกับคนที่เดินทางหรือพกของออกจากบ้านบ่อย"
    },
    home: {
      primaryPainPoint: "ของใช้ในบ้านหรือมุมใช้งานยังไม่ลงตัว",
      problemSolved: "ช่วยให้กิจวัตรในบ้านสะดวกและเป็นระเบียบขึ้น",
      dailyBenefit: "หยิบใช้กับมุมที่ใช้บ่อยได้ง่าย",
      emotionalBenefit: "ช่วยให้บ้านดูใช้งานง่ายและสบายขึ้น",
      purchaseReason: "น่าลองสำหรับคนที่อยากให้ชีวิตประจำวันง่ายขึ้น"
    }
  };
  const preset = templates[group] ?? templates.home;
  return {
    ...storyboard,
    primaryPainPoint: preset.primaryPainPoint,
    problemSolved: compactProductText(storyboard.keySellingPoint || preset.problemSolved, 110),
    dailyBenefit: compactProductText(storyboard.mainUseCase || preset.dailyBenefit, 90),
    emotionalBenefit: preset.emotionalBenefit,
    realUsageScenario: compactProductText(storyboard.usageScene || preset.dailyBenefit, 90),
    purchaseReason: preset.purchaseReason
  };
}

const SHOPEE_STORYBOARD_RULES: ShopeeStoryboardRule[] = [
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
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /กระติก|bottle|ขวดน้ำ/i.test(haystack) ? "กระติกน้ำเก็บอุณหภูมิ" : "แก้วเก็บความเย็น",
      whatItIs: "ภาชนะสำหรับพกเครื่องดื่มและช่วยเก็บอุณหภูมิ",
      mainUseCase: "ใส่น้ำหรือเครื่องดื่มไว้จิบระหว่างวัน",
      targetUser: "คนทำงาน เดินทาง หรืออยากพกน้ำติดตัว",
      keySellingPoint: "พกเครื่องดื่มออกนอกบ้านได้สะดวกและลดการเติมน้ำบ่อย",
      usageScene: "โต๊ะทำงาน รถยนต์ หรือวันที่ออกไปข้างนอก",
      captionAngle: "เติมเครื่องดื่มตอนเช้าไว้จิบระหว่างวันได้สะดวก พกไปทำงานหรือออกข้างนอกได้ง่าย"
    })
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
    pattern: /น้ำยาซัก|detergent|laundry|ปรับผ้านุ่ม|ซักผ้า|ทำความสะอาด|ไม้ถู|ชั้นวาง|กล่องเก็บ|จัดระเบียบ/i,
    build: (product, haystack) => makeShopeeStoryboard(product, {
      productType: /ซัก|detergent|laundry|ปรับผ้านุ่ม/i.test(haystack) ? "ผลิตภัณฑ์ซักผ้า" : "ของใช้ในบ้าน",
      whatItIs: "ของใช้สำหรับดูแลบ้านหรือจัดพื้นที่ใช้งาน",
      mainUseCase: /ซัก|detergent|laundry|ปรับผ้านุ่ม/i.test(haystack) ? "ใช้ซักผ้าหรือดูแลผ้าในบ้าน" : "ใช้จัดเก็บ ทำความสะอาด หรือช่วยให้บ้านเป็นระเบียบ",
      targetUser: "คนที่ดูแลบ้านหรืออยากให้มุมใช้งานสะดวกขึ้น",
      keySellingPoint: /ซัก|detergent|laundry|ปรับผ้านุ่ม/i.test(haystack) ? "ช่วยให้การซักผ้าในบ้านเป็น routine ที่ง่ายขึ้น" : "ช่วยลดความรกและหยิบของได้เป็นที่",
      usageScene: /ซัก|detergent|laundry|ปรับผ้านุ่ม/i.test(haystack) ? "มุมซักผ้าหรือเครื่องซักผ้า" : "ห้องครัว ห้องน้ำ หรือมุมเก็บของ",
      captionAngle: /ซัก|detergent|laundry|ปรับผ้านุ่ม/i.test(haystack)
        ? "มีติดบ้านไว้ใช้กับรอบซักผ้าได้สะดวก เหมาะกับบ้านที่ซักผ้าเป็นประจำ"
        : "ช่วยให้มุมที่ใช้บ่อยเป็นระเบียบขึ้น หยิบของง่ายและไม่กินพื้นที่เกินไป"
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
    .replace(/[✨🔥😍😋💯👍🎯🛒💥⭐📌📍🥤☕🧊💡🏠🏃⚽🎾🚗🍳📱💻💚💖👟📷⌚🎒🏸🦷🌀]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  const rules: Array<[RegExp, string]> = [
    [/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|car\s?camera|drive\s?recorder|บันทึกภาพรถ|กล้องรถ|gps\s*built/i, "กล้องติดรถยนต์"],
    [/จัมป์สตาร์ท|jump\s?starter|แบตเตอรี่รถ|เติมลม|ยางรถ|รถยนต์|automotive/i, "อุปกรณ์รถยนต์"],
    [/insta360|action\s?cam|กล้องแอคชั่?น|กล้อง|camera/i, "กล้องพกพา"],
    [/ลูกแบด|shuttlecock|badminton|แบดมินตัน/i, "ลูกแบดมินตัน"],
    [/รองเท้า|running\s?shoe|sneaker|adidas|nike|shoe/i, /วิ่ง|running/i.test(haystack) ? "รองเท้าวิ่ง" : "รองเท้ากีฬา"],
    [/ถุงเท้า|sock|yonex/i, "ถุงเท้ากีฬา"],
    [/เวย์|whey|protein|โปรตีน/i, "เวย์โปรตีน"],
    [/อาหารเสริม|supplement|วิตามิน|vitamin|ผลิตภัณฑ์สุขภาพ/i, "อาหารเสริม"],
    [/สกินแคร์|skincare|serum|เซรั่ม|ครีม|กันแดด|sunscreen|spf|ผิว|cosmetic/i, "สกินแคร์"],
    [/แก้ว|tumbler|cup|กระติก|ขวดน้ำ|bottle|เก็บความเย็น|เก็บอุณหภูมิ/i, "แก้วเก็บอุณหภูมิ"],
    [/ถาดน้ำแข็ง|น้ำแข็ง/i, "ถาดทำน้ำแข็ง"],
    [/ครัว|kitchen|หม้อ|กระทะ|กล่องอาหาร|ช้อน|จาน/i, "อุปกรณ์ครัว"],
    [/โคมไฟ|lamp|desk\s?light|led\s?light|อ่านหนังสือ|ถนอมสายตา/i, "โคมไฟตั้งโต๊ะ"],
    [/หูฟัง|earbud|earphone|headphone|bluetooth|ลำโพง|speaker/i, "แกดเจ็ตเสียง"],
    [/smart\s?watch|สมาร์ทวอทช์|นาฬิกาอัจฉริยะ|fitness\s?tracker/i, "สมาร์ทวอทช์"],
    [/กระเป๋า|bag|เป้|คาดอก|crossbody|wallet/i, "กระเป๋าพกพา"],
    [/art\s?toy|อาร์ตทอย|กล่องสุ่ม|blind\s?box|figure|ฟิกเกอร์|โมเดล|ของสะสม|ตุ๊กตา|จุ่ม/i, "Art Toy / ของสะสม"],
    [/สัตว์|pet|แมว|cat|สุนัข|dog|อาหารสัตว์|ทรายแมว|ปลอกคอ/i, "อุปกรณ์สัตว์เลี้ยง"],
    [/น้ำยาซัก|detergent|laundry|ปรับผ้านุ่ม|ซักผ้า|ทำความสะอาด|ไม้ถู|ชั้นวาง|กล่องเก็บ|จัดระเบียบ/i, "ของใช้ในบ้าน"],
    [/ขนม|snack|อาหาร(?!เสริม)|food|เครื่องดื่ม|drink|กาแฟ|coffee|ชา|tea|เปี๊ยะ|คุกกี้|เค้ก|น้ำพริก/i, /น้ำพริก/i.test(haystack) ? "น้ำพริก / ของกินติดบ้าน" : "ของกินติดบ้าน"]
  ];

  const matched = rules.find(([pattern]) => pattern.test(haystack));
  return compactProductText(matched?.[1] || simpleName || "ไอเทมใช้งานประจำวัน", 48);
}

function createFallbackShopeeProductStoryboard(product: ShopeeProductRecord, haystack: string): ShopeeProductStoryboard {
  const productType = inferShopeeFallbackProductType(product, haystack);
  const simpleName = getShopeeCaptionProductName(product.productName || productType);
  const usageFromDescription = compactProductText(
    removeShopeeProductNameFromText(product.productDescription || "", product.productName),
    90
  );
  const mainUseCase = usageFromDescription || `หยิบใช้${productType}ในสถานการณ์ที่ต้องการ`;
  const targetUser = `คนที่กำลังมองหา${productType}ไว้ใช้งาน`;
  const usageScene = /รถ/.test(productType)
    ? "ในรถหรือระหว่างเดินทาง"
    : /กีฬา|วิ่ง|แบด|รองเท้า|ถุงเท้า/.test(productType)
      ? "ตอนออกกำลังกายหรือทำกิจกรรม"
      : /ครัว|แก้ว|กระติก|น้ำแข็ง|อาหาร|ขนม|น้ำพริก/.test(productType)
        ? "ในครัวหรือช่วงใช้งานที่บ้าน"
        : /สกินแคร์|อาหารเสริม|วิตามิน|เวย์|โปรตีน/.test(productType)
          ? "ใน routine ดูแลตัวเอง"
          : "ช่วงใช้งานในชีวิตประจำวัน";

  return makeShopeeStoryboard(product, {
    productType,
    whatItIs: simpleName || productType,
    mainUseCase,
    targetUser,
    keySellingPoint: `ช่วยให้หยิบใช้${productType}ได้สะดวกขึ้นเวลาต้องใช้จริง`,
    usageScene,
    captionAngle: `เล่าประโยชน์ของ${productType}ในมุมใช้งานจริงแบบสั้นและอ่านง่าย`
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
    storyboard.productType?.trim() &&
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
  const typeTags = storyboard.productType
    .split(/[\/\s]+/u)
    .map((part) => normalizeHashtagToken(part))
    .filter((tag) => tag && !isForbiddenShopeeHashtag(tag));
  const audienceTags = storyboard.targetUser
    .split(/[\/\s]+/u)
    .map((part) => normalizeHashtagToken(part))
    .filter((tag) => tag && !isForbiddenShopeeHashtag(tag));
  return Array.from(new Set([...typeTags, ...audienceTags, "#Shopee"]))
    .filter((tag) => tag && !isShopeeProductNameDuplicateText(tag.replace(/^#/, ""), storyboard.productSimpleName))
    .slice(0, SHOPEE_MAX_HASHTAGS);
}

function getShopeeStoryboardBenefitEmojis(productType: string) {
  if (/กล้องติดรถ|กล้องหน้ารถ|dash\s?cam|บันทึกภาพรถ/i.test(productType)) return ["📹", "🛣️", "🚘", "🔎"];
  if (/รถ|จัมป์|จั๊ม|ยาง|แบต/.test(productType)) return ["🔋", "💨", "🔦", "📱"];
  if (/ลูกแบด|กีฬา|วิ่ง|รองเท้า|ถุงเท้า/.test(productType)) return ["🏃", "💪", "🎯", "🏸"];
  if (/อาหาร|ขนม|น้ำพริก/.test(productType) && !/อาหารเสริม|วิตามิน|เวย์|โปรตีน/.test(productType)) return ["🌶️", "🍽️", "😋", "🏠"];
  if (/สกินแคร์|เซรั่ม|กันแดด|ผิว/.test(productType)) return ["✨", "💖", "🌸", "💄"];
  if (/กล้อง|มือถือ|หูฟัง|สมาร์ทวอทช์|แกดเจ็ต/.test(productType)) return ["📱", "📸", "🚶", "🎥"];
  if (/ครัว|แก้ว|กระติก|ขวดน้ำ|ถาดน้ำแข็ง/.test(productType)) return ["🥤", "🍳", "💧", "🏠"];
  if (/กระเป๋า|เดินทาง|แคมป์|เที่ยว/.test(productType)) return ["🎒", "✈️", "🏕️", "🚶"];
  return ["🏠", "🧹", "👍", "✨"];
}

function formatShopeeStoryboardPriceLine(product: ShopeeProductRecord, storyboard: ShopeeProductStoryboard) {
  const price = formatShopeePrice(product);
  const numericPrice = typeof product.discountPrice === "number" && Number.isFinite(product.discountPrice)
    ? product.discountPrice
    : product.productPrice;
  if (typeof numericPrice === "number" && Number.isFinite(numericPrice)) {
    if (numericPrice < 300) return `${price} ของมันต้องมี`;
    if (numericPrice > 1000) return `${price} คุ้มสำหรับคนใช้งานจริง`;
  }
  return /ใช้งานจริง|ระยะยาว|ฉุกเฉิน|เดินทาง/.test(storyboard.purchaseReason)
    ? `${price} ใช้งานได้ระยะยาว`
    : price;
}

function buildShopeeStoryboardHook(storyboard: ShopeeProductStoryboard) {
  const emoji = getShopeeStoryboardEmoji(storyboard.productType);
  const pain = compactProductText(storyboard.primaryPainPoint || storyboard.problemSolved, 46).replace(/[.!。]+$/u, "");
  if (/[?？]$/u.test(pain)) return `${emoji} ${pain}`;
  return `${emoji} ${pain}?`;
}

function buildShopeeStoryboardBenefits(storyboard: ShopeeProductStoryboard) {
  const emojis = getShopeeStoryboardBenefitEmojis(storyboard.productType);
  const benefits = [
    storyboard.dailyBenefit,
    storyboard.emotionalBenefit,
    storyboard.realUsageScenario,
    storyboard.problemSolved
  ]
    .map((benefit) => compactProductText(benefit, 44).replace(/[.!。?？]+$/u, ""))
    .filter(Boolean)
    .slice(0, 4);
  return benefits.map((benefit, index) => `${emojis[index] ?? "✅"} ${benefit}`);
}

function repairStoryboardAffiliateCaption(caption: string, affiliateLink: string) {
  let normalized = normalizeShopeeCaptionLinkLine(normalizeTextEncoding(caption), affiliateLink)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!/🛒|กดสั่ง|ลิงก์ด้านล่าง|ดูรายละเอียด/iu.test(normalized)) {
    normalized = `${normalized}\n\n🛒 กดสั่งได้ที่ลิงก์ด้านล่าง`;
  }
  if (!normalized.includes(affiliateLink)) {
    normalized = `${normalized}\n\n${formatShopeeShortLinkLine(affiliateLink)}`;
  }
  return normalizeShopeeCaptionLinkLine(normalized, affiliateLink).replace(/\n{3,}/g, "\n\n").trim();
}

type StoryboardCaptionFailedRule = {
  rule: string;
  message: string;
  failedLine?: string;
  expected?: string;
  actual?: string;
};

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
      productType: input.storyboard.productType,
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
      "FIRST_LINE_IS_HOOK",
      "HAS_CTA",
      "HAS_SHOPEE_SHORT_LINK",
      "HAS_PRICE_WHEN_PRICE_EXISTS",
      "NO_FORBIDDEN_SOURCE_LANGUAGE",
      "MAX_4_BENEFIT_BULLETS",
      "PROBLEM_SOLUTION_BENEFIT_CTA_FLOW",
      "STORYBOARD_REQUIRED"
    ]
  };
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
  const normalized = repairStoryboardAffiliateCaption(caption, affiliateLink);
  const failedRules: StoryboardCaptionFailedRule[] = [];
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  const forbidden = /จากรูปสินค้า|จากภาพสินค้า|จากชื่อสินค้า|จากข้อมูลสินค้า|จากข้อมูลที่ระบุ|เห็นได้จากภาพ|ใช้งานได้จากชื่อสินค้า|เหมาะสำหรับจากชื่อสินค้า|จากรายละเอียดสินค้า|จากสเปกสินค้า|ตามข้อมูลสินค้า|ตามภาพสินค้า|ตามข้อมูล|ตามภาพ/iu;
  console.info("[CAPTION_DEBUG_BEFORE_VALIDATION]", getStoryboardCaptionDebugPayload({
    jobId,
    product,
    storyboard,
    affiliateLink,
    caption: normalized
  }));

  if (!normalized) {
    failedRules.push({
      rule: "NON_EMPTY",
      message: "Caption is empty",
      expected: "caption has text",
      actual: "empty caption"
    });
  }
  if (!firstLine || /^(?:💰|🛒|📍|#)/u.test(firstLine)) {
    failedRules.push({
      rule: "FIRST_LINE_IS_HOOK",
      message: "First line must be a Storyboard hook/pain point, not price/CTA/link/hashtag",
      failedLine: firstLine,
      expected: "hook from primaryPainPoint/problemSolved",
      actual: firstLine || "missing first line"
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
  const bulletCount = (normalized.match(/^(?:🔋|💨|🔦|📱|🏃|💪|🎯|🏸|🌶️|🍽️|😋|🏠|✨|💖|🌸|💄|📸|🚶|🎥|🥤|🍳|💧|🎒|✈️|🏕️|🧹|👍|✅)\s/gmu) || []).length;
  if (bulletCount > 4) {
    failedRules.push({
      rule: "MAX_4_BENEFIT_BULLETS",
      message: "Caption has more than 4 benefit bullets",
      expected: "4 benefit bullets or fewer",
      actual: `${bulletCount} bullets`
    });
  }
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
  const hasSolution = /✅|ตัวช่วย|สะดวก|อุ่นใจ|ง่าย|เอาอยู่|ช่วย/iu.test(normalized);
  const hasBenefits = bulletCount >= 1;
  if (!hasSolution || !hasBenefits) {
    failedRules.push({
      rule: "PROBLEM_SOLUTION_BENEFIT_CTA_FLOW",
      message: "Caption must contain problem → solution → benefit → CTA flow",
      expected: "hook, solution line, benefit bullets, CTA",
      actual: `hasSolution=${hasSolution}; bulletCount=${bulletCount}`
    });
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
  return normalized;
}

function buildShopeeStoryboardCaption(input: {
  product: ShopeeProductRecord;
  storyboard: ShopeeProductStoryboard;
  affiliateLink: string;
  jobId?: string;
}) {
  const { product, storyboard, affiliateLink } = input;
  const benefits = buildShopeeStoryboardBenefits(storyboard);
  const caption = [
    buildShopeeStoryboardHook(storyboard),
    "",
    "มีตัวช่วยไว้สะดวกกว่าเดิม ✅",
    "",
    ...benefits,
    "",
    compactProductText(`${storyboard.purchaseReason} 👍`, 80),
    "",
    formatShopeeStoryboardPriceLine(product, storyboard),
    "",
    "🛒 กดสั่งได้ที่ลิงก์ด้านล่าง",
    "",
    formatShopeeShortLinkLine(affiliateLink),
    "",
    getShopeeStoryboardHashtags(product, storyboard).join(" ")
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return assertValidTextEncoding(
    validateStoryboardAffiliateCaption(normalizeShopeeCaptionLinkLine(caption, affiliateLink), storyboard, product, affiliateLink, input.jobId),
    "Shopee storyboard caption"
  );
}

function createValidatedShopeeProductStoryboard(product: ShopeeProductRecord) {
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
    const key = String(product.productId || `${product.shopId}:${product.itemId}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(product);
  }
  return deduped;
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
  const excludedProductIds = new Set((input.excludedProductIds ?? []).map((productId) => String(productId)).filter(Boolean));
  const dailyLocks = process.env.AUTO_POST_NO_DUPLICATE_SAME_DAY === "false"
    ? { productIds: new Set<string>(), identities: new Set<string>(), postedDate: getBangkokPostedDate() }
    : await getShopeeProductLocksForDate(input.userId);
  const categories = normalizeShopeeCategories(input.categories?.length ? input.categories : input.category);
  const discoveryCategories = categories.length ? categories : [DEFAULT_SHOPEE_CATEGORY];
  const limitPerCategory = Math.max(20, input.pageIds.length * Math.max(5, excludedProductIds.size + 5));
  const effectiveCategoryPriority = input.categoryPriority?.length ? input.categoryPriority : categories;
  const discoveredByCategory: ShopeeProductRecord[][] = [];
  const categoryFetchErrors: string[] = [];
  for (const category of discoveryCategories) {
    try {
      discoveredByCategory.push(await provider.fetchProducts({
        sourceTag: input.sourceTag ?? "trending",
        keyword: input.keyword,
        category,
        limit: limitPerCategory
      }));
    } catch (error) {
      categoryFetchErrors.push(`${category}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!discoveredByCategory.length && categoryFetchErrors.length) {
    throw new Error(`Unable to fetch Shopee products for selected categories: ${categoryFetchErrors.join("; ")}`);
  }
  const discovered = shuffleShopeeProducts(dedupeShopeeProducts(discoveredByCategory.flat()));
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
        categoryPriority: effectiveCategoryPriority,
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
  jobId?: string;
}) {
  const { product } = input;
  if (!hasShopeeProductName(product)) {
    throw new ShopeeProviderError(
      `caption generation failed: SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT missing product name for ${product.productId}`,
      422,
      "missing_product_name",
      "internal_api"
    );
  }
  if (!hasShopeeProductImage(product)) {
    throw new ShopeeProviderError(
      `caption generation failed: SKIP_PRODUCT_AND_FETCH_NEW_PRODUCT missing product image for ${product.productId}`,
      422,
      "missing_images",
      "internal_api"
    );
  }
  const storyboard = createValidatedShopeeProductStoryboard(product);
  let storyboardCaption: string;
  try {
    storyboardCaption = buildShopeeStoryboardCaption({
      product,
      storyboard,
      affiliateLink: input.affiliateLink,
      jobId: input.jobId
    });
  } catch (error) {
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
    throw error;
  }
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
    style: input.captionStyle,
    jobId: input.jobId
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


