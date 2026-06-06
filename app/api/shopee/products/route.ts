import { z } from "zod";
import { jsonError, jsonOk, normalizeRouteError, parseBody, requireAuth } from "@/lib/api";
import {
  getShopeeEnvStatus,
  getShopeeProductProvider,
  scoreShopeeProduct,
  ShopeeProviderError,
  upsertShopeeProducts,
  ShopeeSourceTag
} from "@/lib/services/shopee-affiliate";
import { DEFAULT_SHOPEE_CATEGORY, normalizeShopeeCategories, normalizeShopeeCategory } from "@/lib/shopee-categories";

const querySchema = z.object({
  sourceTag: z.enum(["trending", "best_selling", "top_search", "best_roi", "manual"]).default("trending"),
  keyword: z.string().optional(),
  category: z.string().default(DEFAULT_SHOPEE_CATEGORY),
  categories: z.array(z.string()).default([]),
  limit: z.number().min(1).max(50).default(20)
});

function parseSourceTag(value: string | null): ShopeeSourceTag {
  const allowed: ShopeeSourceTag[] = ["trending", "best_selling", "top_search", "best_roi", "manual"];
  return allowed.includes(value as ShopeeSourceTag) ? (value as ShopeeSourceTag) : "trending";
}

async function fetchProductsForCategories(input: {
  provider: ReturnType<typeof getShopeeProductProvider>;
  sourceTag: ShopeeSourceTag;
  keyword?: string;
  categories: string[];
  limit: number;
}) {
  const products = (
    await Promise.all(
      input.categories.map((category) =>
        input.provider.fetchProducts({
          sourceTag: input.sourceTag,
          keyword: input.keyword,
          category,
          limit: input.limit
        })
      )
    )
  ).flat();
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = String(product.productId || `${product.shopId}:${product.itemId}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const url = new URL(request.url);
    const sourceTag = parseSourceTag(url.searchParams.get("sourceTag"));
    const keyword = url.searchParams.get("keyword") ?? undefined;
    const category = normalizeShopeeCategory(url.searchParams.get("category"));
    const categories = normalizeShopeeCategories(url.searchParams.getAll("categories").length ? url.searchParams.getAll("categories") : category);
    const limit = Number(url.searchParams.get("limit") ?? "20");

    const provider = getShopeeProductProvider();
    const envStatus = getShopeeEnvStatus();
    console.info("[shopee/products] internal GET started", {
      userId,
      provider: provider.name,
      providerMode: envStatus.providerMode,
      sourceTag,
      hasKeyword: Boolean(keyword),
      hasCategory: category !== DEFAULT_SHOPEE_CATEGORY,
      categories,
      limit: Number.isFinite(limit) ? limit : 20,
      missingEnv: envStatus.missing
    });
    const products = await fetchProductsForCategories({
      provider,
      sourceTag,
      keyword,
      categories,
      limit: Number.isFinite(limit) ? limit : 20
    });
    await upsertShopeeProducts(products);

    return jsonOk({
      products: products.map((product) => ({
        ...product,
        score: scoreShopeeProduct({ product })
      })),
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
      sourceTag: payload.sourceTag,
      hasKeyword: Boolean(payload.keyword),
      hasCategory: normalizeShopeeCategory(payload.category) !== DEFAULT_SHOPEE_CATEGORY,
      categories: normalizeShopeeCategories((payload.categories ?? []).length ? payload.categories : payload.category),
      limit: payload.limit,
      missingEnv: envStatus.missing
    });
    const products = await fetchProductsForCategories({
      provider,
      sourceTag: payload.sourceTag ?? "trending",
      keyword: payload.keyword,
      categories: normalizeShopeeCategories((payload.categories ?? []).length ? payload.categories : payload.category),
      limit: payload.limit ?? 20
    });
    await upsertShopeeProducts(products);
    return jsonOk({
      products: products.map((product) => ({
        ...product,
        score: scoreShopeeProduct({ product })
      })),
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
