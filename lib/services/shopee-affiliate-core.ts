import crypto from "crypto";
import { buildUgcShopeeImagePromptSet } from "./ugc-image-prompt.ts";

export type ShopeeSourceTag = "trending" | "best_selling" | "top_search" | "best_roi" | "manual";
export type ShopeeCaptionStyle = "soft_sell" | "urgency" | "problem_solution" | "review_style" | "deal_alert" | "lifestyle";

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
  productUrl: string;
  affiliateUrl?: string;
  category: string;
  salesCount?: number;
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

export type ShopeeProductVisualAnalysis = {
  dominantColors: string[];
  shape: string;
  materials: string;
  keyVisualIdentity: string[];
  keySellingPoints: string[];
};

export type ShopeeImagePromptConcept = {
  concept: "hero_product_shot" | "lifestyle_usage" | "close_up_detail" | "viral_review_style";
  title: string;
  prompt: string;
};

export type ShopeeImagePromptSet = {
  productVisualAnalysis: ShopeeProductVisualAnalysis;
  consistencyInstructions: string[];
  prompts: ShopeeImagePromptConcept[];
  negativePrompt: string;
};

export interface ShopeeProductProvider {
  name: string;
  fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]>;
}

function comparableTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function normalizeShopeeComparableText(value: string) {
  return comparableTokens(value).join("");
}

export function getShopeeProductNameSimilarity(text: string, productName: string) {
  const normalizedText = normalizeShopeeComparableText(text);
  const normalizedName = normalizeShopeeComparableText(productName);

  if (!normalizedText || !normalizedName) return 0;
  if (normalizedText === normalizedName) return 1;
  if (normalizedText.includes(normalizedName)) return 1;
  if (normalizedName.includes(normalizedText) && normalizedText.length >= Math.max(8, normalizedName.length * 0.5)) {
    return normalizedText.length / normalizedName.length;
  }

  const textTokens = new Set(comparableTokens(text));
  const nameTokens = comparableTokens(productName);
  if (nameTokens.length === 0) return 0;

  const matched = nameTokens.filter((token) => textTokens.has(token)).length;
  return matched / nameTokens.length;
}

export function isShopeeProductNameDuplicateText(text: string, productName: string, threshold = 0.7) {
  return getShopeeProductNameSimilarity(text, productName) >= threshold;
}

export function stripShopeeProductNameFromText(text: string, productName: string) {
  let output = text.trim();
  if (!output || !productName.trim()) return output;

  const escapedName = productName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  output = output.replace(new RegExp(escapedName, "gi"), "").replace(/\s{2,}/g, " ").trim();

  return isShopeeProductNameDuplicateText(output, productName) ? "" : output;
}

export function removeDuplicateShopeeProductNameLines(lines: string[], productName: string) {
  let keptProductName = false;

  return lines.flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];

    if (!keptProductName && isShopeeProductNameDuplicateText(trimmed, productName)) {
      keptProductName = true;
      return [productName.trim()];
    }

    if (isShopeeProductNameDuplicateText(trimmed, productName)) {
      const stripped = stripShopeeProductNameFromText(trimmed, productName);
      return stripped && /[\p{L}\p{N}]/u.test(stripped) ? [stripped] : [];
    }

    return [trimmed];
  });
}

export function countShopeeProductNameOccurrences(caption: string, productName: string) {
  const lines = caption
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.reduce((count, line) => count + (isShopeeProductNameDuplicateText(line, productName) ? 1 : 0), 0);
}

export class MockShopeeProvider implements ShopeeProductProvider {
  name = "mock_shopee_provider";

  async fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]> {
    const now = new Date();
    const sourceTag = query.sourceTag ?? "trending";
    const keyword = query.keyword?.trim() || "ของใช้ยอดนิยม";
    const category = query.category?.trim() || "Lifestyle";
    const limit = Math.max(1, Math.min(query.limit ?? 20, 50));

    const samples: ShopeeProductRecord[] = [
      {
        productId: "mock-thermal-cup",
        shopId: "10001",
        itemId: "90001",
        productName: "แก้วเก็บอุณหภูมิพกพา 600ml",
        productDescription: "แก้วสแตนเลสเก็บเย็น/ร้อน เหมาะกับออฟฟิศ เดินทาง และสายคาเฟ่",
        productPrice: 299,
        discountPrice: 159,
        discountPercent: 47,
        productImageUrl: "https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=1200&auto=format&fit=crop",
        productUrl: "https://shopee.co.th/product/10001/90001",
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
        productDescription: "ขนาดเล็ก ใช้ง่าย เหมาะกับโต๊ะทำงาน รถยนต์ และมุมเล็ก ๆ ในบ้าน",
        productPrice: 490,
        discountPrice: 249,
        discountPercent: 49,
        productImageUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&auto=format&fit=crop",
        productUrl: "https://shopee.co.th/product/10002/90002",
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
        productDescription: "ไฟนุ่ม ปรับมุมได้ เหมาะกับโต๊ะเครื่องแป้งและสายแต่งหน้า",
        productPrice: 399,
        discountPrice: 219,
        discountPercent: 45,
        productImageUrl: "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=1200&auto=format&fit=crop",
        productUrl: "https://shopee.co.th/product/10003/90003",
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

export function mapExternalProduct(sourceTag: ShopeeSourceTag) {
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
      productPrice: Number(item.product_price ?? item.price ?? 0),
      discountPrice: item.discount_price === undefined ? undefined : Number(item.discount_price),
      discountPercent: item.discount_percent === undefined ? undefined : Number(item.discount_percent),
      productImageUrl: String(item.product_image_url ?? item.image ?? item.productImageUrl ?? ""),
      productUrl: String(item.product_url ?? item.url ?? item.productUrl ?? ""),
      affiliateUrl: item.affiliate_url ? String(item.affiliate_url) : undefined,
      category: String(item.category ?? "General"),
      salesCount: item.sales_count === undefined ? undefined : Number(item.sales_count),
      rating: item.rating === undefined ? undefined : Number(item.rating),
      commissionRate: item.commission_rate === undefined ? undefined : Number(item.commission_rate),
      sourceTag,
      fetchedAt: new Date()
    };
  };
}

export function buildAffiliateLinkCore(input: {
  product: ShopeeProductRecord;
  trackingId?: string;
  affiliateBaseUrl?: string;
}) {
  if (input.product.affiliateUrl) {
    return input.product.affiliateUrl;
  }

  const sourceUrl = input.product.productUrl || `https://shopee.co.th/product/${input.product.shopId}/${input.product.itemId}`;

  if (!input.affiliateBaseUrl) {
    const url = new URL(sourceUrl);
    if (input.trackingId) url.searchParams.set("utm_content", input.trackingId);
    url.searchParams.set("utm_source", "prosocial");
    url.searchParams.set("utm_medium", "affiliate_auto_post");
    return url.toString();
  }

  const url = new URL(input.affiliateBaseUrl);
  url.searchParams.set("url", sourceUrl);
  if (input.trackingId) url.searchParams.set("tracking_id", input.trackingId);
  return url.toString();
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

  if (input.categoryPriority?.includes(product.category)) {
    score += 7;
    reason.push("ตรงหมวดหมู่ที่ตั้งค่าไว้");
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
    reason: reason.length ? reason : ["สินค้าอยู่ในเกณฑ์พื้นฐาน"],
    riskFlags
  };
}

function extractFeatureHints(product: ShopeeProductRecord) {
  const text = `${product.productName} ${product.productDescription} ${product.category}`.toLowerCase();
  const hints: string[] = [];

  if (/stainless|steel|สแตนเลส|เหล็ก/.test(text)) hints.push("stainless or metallic finish");
  if (/led|light|ไฟ/.test(text)) hints.push("visible lighting feature");
  if (/mini|compact|portable|มินิ|พกพา/.test(text)) hints.push("compact portable size");
  if (/clear|transparent|ใส/.test(text)) hints.push("transparent or clear material");
  if (/cup|bottle|แก้ว/.test(text)) hints.push("cylindrical drinkware silhouette");
  if (/vacuum|ดูดฝุ่น/.test(text)) hints.push("handheld appliance body");
  if (/mirror|กระจก/.test(text)) hints.push("reflective mirror surface");
  if (/organizer|box|storage|กล่อง|จัดระเบียบ/.test(text)) hints.push("storage organizer form");

  return hints.length ? hints : ["exact visible product silhouette from the reference image"];
}

export function analyzeShopeeProductVisuals(product: ShopeeProductRecord): ShopeeProductVisualAnalysis {
  const featureHints = extractFeatureHints(product);
  const description = product.productDescription || product.productName;

  return {
    dominantColors: ["use the exact colors visible in the product reference image", "do not recolor the product"],
    shape: featureHints.join(", "),
    materials: "infer only from the product reference image and product description; keep materials believable and unchanged",
    keyVisualIdentity: [
      `same product as reference: ${product.productName}`,
      `same category: ${product.category}`,
      "same shape, proportions, color, labels, logo placement, accessories, and visible components",
      "use product_image_url as the identity reference whenever available"
    ],
    keySellingPoints: [
      description,
      product.discountPercent ? `${product.discountPercent}% discount cue, shown as a safe deal highlight only` : "everyday practical value",
      product.rating ? `rating signal ${product.rating}, without fake review screenshots` : "trustworthy social-commerce presentation"
    ].filter(Boolean)
  };
}

export function buildShopeeImagePromptSet(product: ShopeeProductRecord, style: ShopeeCaptionStyle = "soft_sell"): ShopeeImagePromptSet {
  const analysis = analyzeShopeeProductVisuals(product);
  return buildUgcShopeeImagePromptSet(product, style, analysis);
}

export function buildShopeeImagePrompt(product: ShopeeProductRecord, style: ShopeeCaptionStyle = "soft_sell") {
  return buildShopeeImagePromptSet(product, style).prompts[0].prompt;
}
