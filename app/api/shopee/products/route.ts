import { z } from "zod";
import { jsonError, jsonOk, normalizeRouteError, parseBody, requireAuth } from "@/lib/api";
import {
  getShopeeEnvStatus,
  getShopeeProductProvider,
  fetchShopeeAllProductsForSelectedCategories,
  ShopeeProviderError,
  getShopeeCanonicalProductKey,
  upsertShopeeProducts,
} from "@/lib/services/shopee-affiliate";
import { DEFAULT_SHOPEE_CATEGORY, normalizeShopeeCategories, normalizeShopeeCategory } from "@/lib/shopee-categories";

const querySchema = z.object({
  category: z.string().default(DEFAULT_SHOPEE_CATEGORY),
  categories: z.array(z.string()).default([]),
  minSoldCount: z.number().min(0).default(0),
  limit: z.number().min(1).max(50).default(20)
});

async function fetchProductsForCategories(input: {
  userId: string;
  categories: string[];
  minSoldCount?: number;
  limit: number;
}) {
  const categories = input.categories.length ? input.categories : [DEFAULT_SHOPEE_CATEGORY];
  const products = await fetchShopeeAllProductsForSelectedCategories({
    userId: input.userId,
    selectedCategoryIds: categories,
    limit: input.limit,
    randomSeed: `${categories.join(",")}:${Date.now()}`
  });
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = getShopeeCanonicalProductKey(product) || String(product.productId || `${product.shopId}:${product.itemId}`);
    if (!key || seen.has(key)) return false;
    if ((input.minSoldCount ?? 0) > 0 && (product.salesCount ?? 0) < (input.minSoldCount ?? 0)) return false;
    seen.add(key);
    return true;
  });
}

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const url = new URL(request.url);
    const category = normalizeShopeeCategory(url.searchParams.get("category"));
    const categories = normalizeShopeeCategories(url.searchParams.getAll("categories").length ? url.searchParams.getAll("categories") : category);
    const minSoldCount = Number(url.searchParams.get("minSoldCount") ?? "0") || 0;
    const limit = Number(url.searchParams.get("limit") ?? "20");

    const provider = getShopeeProductProvider();
    const envStatus = getShopeeEnvStatus();
    console.info("[shopee/products] internal GET started", {
      userId,
      provider: provider.name,
      providerMode: envStatus.providerMode,
      hasCategory: category !== DEFAULT_SHOPEE_CATEGORY,
      categories,
      limit: Number.isFinite(limit) ? limit : 20,
      missingEnv: envStatus.missing
    });
    const products = await fetchProductsForCategories({
      userId,
      categories,
      minSoldCount,
      limit: Number.isFinite(limit) ? limit : 20
    });
    await upsertShopeeProducts(products);

    return jsonOk({
      products,
      count: products.length,
      provider: provider.name
    });
  } catch (error) {
    if (error instanceof ShopeeProviderError) {
      console.warn("[shopee/products] provider error", {
        source: error.source,
        status: error.status,
        code: error.code,
        message: error.message,
        responseSummary: error.responseSummary
      });
      return jsonError(error.message, error.status, error.code);
    }
    const normalized = normalizeRouteError(error, "Unable to load Shopee products");
    console.error("[shopee/products] internal GET failed", {
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
      source: normalized.status === 401 ? "internal_api" : "unknown"
    });
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(querySchema, await request.json());
    const provider = getShopeeProductProvider();
    const envStatus = getShopeeEnvStatus();
    console.info("[shopee/products] internal POST started", {
      userId,
      provider: provider.name,
      providerMode: envStatus.providerMode,
      hasCategory: normalizeShopeeCategory(payload.category) !== DEFAULT_SHOPEE_CATEGORY,
      categories: normalizeShopeeCategories((payload.categories ?? []).length ? payload.categories : payload.category),
      limit: payload.limit,
      missingEnv: envStatus.missing
    });
    const products = await fetchProductsForCategories({
      userId,
      categories: normalizeShopeeCategories((payload.categories ?? []).length ? payload.categories : payload.category),
      minSoldCount: payload.minSoldCount ?? 0,
      limit: payload.limit ?? 20
    });
    await upsertShopeeProducts(products);
    return jsonOk({
      products,
      count: products.length,
      provider: provider.name
    });
  } catch (error) {
    if (error instanceof ShopeeProviderError) {
      console.warn("[shopee/products] provider error", {
        source: error.source,
        status: error.status,
        code: error.code,
        message: error.message,
        responseSummary: error.responseSummary
      });
      return jsonError(error.message, error.status, error.code);
    }
    const normalized = normalizeRouteError(error, "Unable to discover Shopee products");
    console.error("[shopee/products] internal POST failed", {
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
      source: normalized.status === 401 ? "internal_api" : "unknown"
    });
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
