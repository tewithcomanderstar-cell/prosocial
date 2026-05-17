import { z } from "zod";
import { jsonError, jsonOk, normalizeRouteError, parseBody, requireAuth } from "@/lib/api";
import {
  getShopeeProductProvider,
  scoreShopeeProduct,
  upsertShopeeProducts,
  ShopeeSourceTag
} from "@/lib/services/shopee-affiliate";

const querySchema = z.object({
  sourceTag: z.enum(["trending", "best_selling", "top_search", "best_roi", "manual"]).default("trending"),
  keyword: z.string().optional(),
  category: z.string().optional(),
  limit: z.number().min(1).max(50).default(20)
});

function parseSourceTag(value: string | null): ShopeeSourceTag {
  const allowed: ShopeeSourceTag[] = ["trending", "best_selling", "top_search", "best_roi", "manual"];
  return allowed.includes(value as ShopeeSourceTag) ? (value as ShopeeSourceTag) : "trending";
}

export async function GET(request: Request) {
  try {
    await requireAuth();
    const url = new URL(request.url);
    const sourceTag = parseSourceTag(url.searchParams.get("sourceTag"));
    const keyword = url.searchParams.get("keyword") ?? undefined;
    const category = url.searchParams.get("category") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "20");

    const provider = getShopeeProductProvider();
    const products = await provider.fetchProducts({
      sourceTag,
      keyword,
      category,
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
    const normalized = normalizeRouteError(error, "Unable to load Shopee products");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth();
    const payload = parseBody(querySchema, await request.json());
    const provider = getShopeeProductProvider();
    const products = await provider.fetchProducts(payload);
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
    const normalized = normalizeRouteError(error, "Unable to discover Shopee products");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
