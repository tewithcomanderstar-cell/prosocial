import crypto from "crypto";
import { generateFacebookContent } from "@/lib/services/ai";
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

export type ShopeePostPackage = {
  product: ShopeeProductRecord;
  caption: string;
  imagePrompt: string;
  generatedImageUrl: string;
  affiliateLink: string;
  imageStatus: "pending" | "generating" | "generated" | "failed" | "skipped";
  scheduledAt: Date;
  pageId: string;
  status: "draft" | "generated" | "image_ready" | "queued" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
};

export interface ShopeeProductProvider {
  name: string;
  fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]>;
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

export class ShopeeOfficialApiProvider implements ShopeeProductProvider {
  name = "shopee_official_api_provider";

  async fetchProducts(query: ProductDiscoveryQuery): Promise<ShopeeProductRecord[]> {
    const endpoint = process.env.SHOPEE_AFFILIATE_API_URL;
    const partnerId = process.env.SHOPEE_PARTNER_ID;
    const partnerKey = process.env.SHOPEE_PARTNER_KEY;

    if (!endpoint || !partnerId || !partnerKey) {
      return new MockShopeeProvider().fetchProducts(query);
    }

    // Adapter shell: keep official API specifics isolated so we can swap endpoint contracts safely.
    const url = new URL(endpoint);
    if (query.keyword) url.searchParams.set("keyword", query.keyword);
    if (query.category) url.searchParams.set("category", query.category);
    if (query.sourceTag) url.searchParams.set("source_tag", query.sourceTag);
    url.searchParams.set("limit", String(Math.max(1, Math.min(query.limit ?? 20, 50))));

    const response = await fetch(url, {
      headers: {
        "content-type": "application/json",
        "x-shopee-partner-id": partnerId,
        "x-shopee-signature": crypto.createHmac("sha256", partnerKey).update(url.pathname + url.search).digest("hex")
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Shopee API request failed: ${response.status}`);
    }

    const payload = (await response.json()) as { products?: Array<Record<string, unknown>> };
    return (payload.products ?? []).map(mapExternalProduct(query.sourceTag ?? "trending"));
  }
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

export function getShopeeProductProvider(): ShopeeProductProvider {
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
  const sourceUrl = product.productUrl || `https://shopee.co.th/product/${product.shopId}/${product.itemId}`;

  if (!base) {
    const url = new URL(sourceUrl);
    if (trackingId) url.searchParams.set("utm_content", trackingId);
    url.searchParams.set("utm_source", "prosocial");
    url.searchParams.set("utm_medium", "affiliate_auto_post");
    return url.toString();
  }

  const url = new URL(base);
  url.searchParams.set("url", sourceUrl);
  if (trackingId) url.searchParams.set("tracking_id", trackingId);
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
          productUrl: product.productUrl,
          affiliateUrl: product.affiliateUrl,
          category: product.category,
          salesCount: product.salesCount,
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
}) {
  const provider = getShopeeProductProvider();
  const discovered = await provider.fetchProducts({
    sourceTag: input.sourceTag ?? "trending",
    keyword: input.keyword,
    category: input.category,
    limit: Math.max(20, input.pageIds.length * 5)
  });
  await upsertShopeeProducts(discovered);

  const selected: Array<{ pageId: string; product: ShopeeProductRecord; score: ProductScore }> = [];
  const usedProductIds = new Set<string>();

  for (const pageId of input.pageIds) {
    const scored = [];
    for (const product of discovered) {
      const recentlyPosted = await wasProductRecentlyPosted(input.userId, pageId, product.productId);
      const score = scoreShopeeProduct({
        product,
        recentlyPosted: recentlyPosted || usedProductIds.has(product.productId),
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
      throw new Error("No eligible Shopee products found for the current filters");
    }

    usedProductIds.add(best.product.productId);
    selected.push({ pageId, product: best.product, score: best.score });
  }

  return selected;
}

export function buildShopeeImagePrompt(product: ShopeeProductRecord, style: ShopeeCaptionStyle = "soft_sell") {
  const priceText = product.discountPrice
    ? `highlight an attractive deal around ${product.discountPrice} THB without fake claims`
    : "highlight practical everyday value without fake claims";

  return [
    "Create a clean promotional lifestyle image for a Facebook affiliate post.",
    `Product: ${product.productName}.`,
    `Category: ${product.category}.`,
    `Context: ${product.productDescription || "useful everyday product"}.`,
    `Style: ${style.replace(/_/g, " ")} Thai social commerce, bright, trustworthy, modern.`,
    priceText,
    "Do not add Shopee logos, fake brand endorsements, unrealistic before-after claims, or misleading medical/financial claims.",
    "Leave safe space for a short Thai headline overlay."
  ].join(" ");
}

export async function generateShopeeCaption(input: {
  userId: string;
  product: ShopeeProductRecord;
  affiliateLink: string;
  style?: ShopeeCaptionStyle;
  disclosureText?: string;
}) {
  const { product } = input;
  const style = input.style ?? "soft_sell";
  const disclosure = input.disclosureText?.trim() || "ลิงก์นี้เป็นลิงก์ Affiliate";
  const priceLine = product.discountPrice
    ? `ราคาโปร/ส่วนลด: ${product.discountPrice} บาท (ลดประมาณ ${product.discountPercent ?? 0}%)`
    : `ราคา: ${product.productPrice} บาท`;
  const fallback = [
    `เจอดีลน่าสนใจมาแชร์ครับ ✨`,
    `${product.productName}`,
    product.productDescription ? `เหมาะกับคนที่อยากได้ ${product.productDescription}` : "เหมาะกับใช้ในชีวิตประจำวัน",
    priceLine,
    `ดูรายละเอียด/กดรับดีล: ${input.affiliateLink}`,
    disclosure,
    "#ShopeeAffiliate #ดีลน่าใช้ #ของมันต้องมี"
  ].join("\n");

  const customPrompt = `เขียนแคปชั่น Facebook ภาษาไทยสำหรับ Shopee Affiliate แบบ ${style}
โครงสร้าง:
1. Hook เปิดให้หยุดอ่าน
2. บอกประโยชน์สินค้าแบบไม่กล่าวอ้างเกินจริง
3. เน้นราคา/ส่วนลดถ้ามี
4. CTA ให้กดดูรายละเอียด
5. ต้องมีลิงก์ Affiliate นี้: ${input.affiliateLink}
6. ต้องมี disclosure: ${disclosure}
7. ใส่ hashtag 3-5 ตัว

ห้าม:
- ห้ามอ้างว่าเป็นของแท้/รักษาโรค/การันตีผลลัพธ์ ถ้าไม่มีข้อมูล
- ห้ามพูดเหมือนรีวิวจากการใช้จริงถ้าไม่มีข้อมูล
- ห้ามลืมลิงก์และ disclosure`;

  try {
    const variants = await generateFacebookContent(product.productName, {
      userId: input.userId,
      customPrompt,
      sourceLabel: "Shopee affiliate product data",
      sourceText: [
        `Product name: ${product.productName}`,
        `Description: ${product.productDescription}`,
        priceLine,
        `Sales count: ${product.salesCount ?? "-"}`,
        `Rating: ${product.rating ?? "-"}`,
        `Commission rate: ${product.commissionRate ?? "-"}%`,
        `Affiliate link: ${input.affiliateLink}`
      ].join("\n")
    });
    const chosen = variants?.length ? randomItem(variants) : null;
    if (!chosen?.caption) return fallback;
    const hashtags = chosen.hashtags?.length
      ? `\n\n${chosen.hashtags.map((tag: string) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")}`
      : "";
    const withLink = chosen.caption.includes(input.affiliateLink)
      ? chosen.caption
      : `${chosen.caption.trim()}\n\nดูรายละเอียด/กดรับดีล: ${input.affiliateLink}`;
    const withDisclosure = withLink.includes(disclosure) ? withLink : `${withLink}\n${disclosure}`;
    return `${withDisclosure.trim()}${hashtags}`.trim();
  } catch {
    return fallback;
  }
}

export async function buildShopeePostPackage(input: {
  userId: string;
  pageId: string;
  product: ShopeeProductRecord;
  scheduledAt: Date;
  captionStyle?: ShopeeCaptionStyle;
  trackingId?: string;
}) {
  const affiliateLink = buildAffiliateLink(input.product, input.trackingId);
  const imagePrompt = buildShopeeImagePrompt(input.product, input.captionStyle ?? "soft_sell");
  const caption = await generateShopeeCaption({
    userId: input.userId,
    product: input.product,
    affiliateLink,
    style: input.captionStyle
  });

  const imageDoc = await AiGeneratedImage.create({
    userId: input.userId,
    productId: input.product.productId,
    prompt: imagePrompt,
    status: "skipped",
    generatedImageUrl: input.product.productImageUrl,
    fallbackImageUrl: input.product.productImageUrl,
    provider: "fallback_product_image"
  });

  const postDoc = await AiGeneratedPost.create({
    userId: input.userId,
    productId: input.product.productId,
    caption,
    imagePrompt,
    generatedImageUrl: input.product.productImageUrl,
    affiliateLink,
    scheduledAt: input.scheduledAt,
    pageId: input.pageId,
    status: "generated",
    generationMetaJson: {
      imageId: String(imageDoc._id),
      source: "shopee-affiliate"
    }
  });

  await AffiliateLink.findOneAndUpdate(
    { userId: input.userId, productId: input.product.productId, trackingId: input.trackingId ?? "default" },
    {
      userId: input.userId,
      productId: input.product.productId,
      affiliateUrl: affiliateLink,
      trackingId: input.trackingId ?? "default",
      sourceUrl: input.product.productUrl
    },
    { upsert: true, new: true }
  );

  return {
    product: input.product,
    caption,
    imagePrompt,
    generatedImageUrl: input.product.productImageUrl,
    affiliateLink,
    imageStatus: "skipped",
    scheduledAt: input.scheduledAt,
    pageId: input.pageId,
    status: "generated",
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
}) {
  await FacebookPostQueue.create({
    userId: input.userId,
    pageId: input.pageId,
    postId: input.postId,
    productId: input.product.productId,
    affiliateLink: input.affiliateLink,
    scheduledAt: input.scheduledAt,
    status: "queued",
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
