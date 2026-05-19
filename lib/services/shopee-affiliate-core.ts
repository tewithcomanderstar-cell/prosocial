import crypto from "crypto";

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

  if (/stainless|steel|à¸ªà¹à¸•à¸™à¹€à¸¥à¸ª|à¹€à¸«à¸¥à¹‡à¸/.test(text)) hints.push("stainless or metallic finish");
  if (/led|light|à¹„à¸Ÿ/.test(text)) hints.push("visible lighting feature");
  if (/mini|compact|portable|à¸¡à¸´à¸™à¸´|à¸žà¸à¸žà¸²/.test(text)) hints.push("compact portable size");
  if (/clear|transparent|à¹ƒà¸ª/.test(text)) hints.push("transparent or clear material");
  if (/cup|bottle|à¹à¸à¹‰à¸§/.test(text)) hints.push("cylindrical drinkware silhouette");
  if (/vacuum|à¸”à¸¹à¸”à¸à¸¸à¹ˆà¸™/.test(text)) hints.push("handheld appliance body");
  if (/mirror|à¸à¸£à¸°à¸ˆà¸/.test(text)) hints.push("reflective mirror surface");
  if (/organizer|box|storage|à¸à¸¥à¹ˆà¸­à¸‡|à¸ˆà¸±à¸”à¸£à¸°à¹€à¸šà¸µà¸¢à¸š/.test(text)) hints.push("storage organizer form");

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

function buildPromptHeader(product: ShopeeProductRecord, style: ShopeeCaptionStyle, analysis: ShopeeProductVisualAnalysis) {
  return [
    "Use the provided product_image_url as the visual identity reference source.",
    `Reference product image URL: ${product.productImageUrl || "not provided"}.`,
    `Product name: ${product.productName}.`,
    `Category: ${product.category}.`,
    `Description/features: ${product.productDescription || "useful everyday product"}.`,
    `Visual identity: ${analysis.keyVisualIdentity.join("; ")}.`,
    `Shape/material hints: ${analysis.shape}; ${analysis.materials}.`,
    `Social commerce style: ${style.replace(/_/g, " ")}, realistic Thai Facebook affiliate content, high CTR, trustworthy, emotional but believable.`,
    "Safety: do not add Shopee logos, fake brand endorsements, fake reviews, fake screenshots, misleading health claims, or unrealistic product transformations."
  ].join(" ");
}

export function buildShopeeImagePromptSet(product: ShopeeProductRecord, style: ShopeeCaptionStyle = "soft_sell"): ShopeeImagePromptSet {
  const analysis = analyzeShopeeProductVisuals(product);
  const header = buildPromptHeader(product, style, analysis);
  const priceCue = product.discountPrice
    ? `Subtly highlight the deal around ${product.discountPrice} THB and ${product.discountPercent ?? 0}% discount without fake scarcity.`
    : "Subtly highlight practical everyday value without fake price claims.";

  const consistencyInstructions = [
    "The product must remain the exact same item across all four images.",
    "Preserve product shape, color, proportions, branding, label placement, accessories, and visible details from the reference image.",
    "Only change camera angle, background, lighting, usage context, and composition.",
    "Do not redesign, recolor, simplify, mutate, upscale into a different premium product, or add fake features.",
    "No Shopee logo unless it exists on the actual product packaging in the reference image."
  ];

  const prompts: ShopeeImagePromptConcept[] = [
    {
      concept: "hero_product_shot",
      title: "Prompt 1: Hero Shot",
      prompt: [
        header,
        "IMAGE 1 HERO PRODUCT SHOT: clean product-focused composition for a Facebook feed first impression.",
        "Camera: 3/4 front angle, slightly above eye level, product centered and large, enough safe space for a short Thai headline overlay.",
        "Lighting: cinematic softbox lighting, crisp highlights, premium but believable marketplace look.",
        "Background: clean modern Thai social commerce backdrop with subtle warm gradient and soft shadow, no clutter.",
        "CTR strategy: make the exact product instantly recognizable, bright contrast, clear silhouette, emotional desire to click.",
        priceCue
      ].join(" ")
    },
    {
      concept: "lifestyle_usage",
      title: "Prompt 2: Lifestyle",
      prompt: [
        header,
        "IMAGE 2 LIFESTYLE USAGE: show the same exact product being used naturally in a relatable everyday Thai setting.",
        "Camera: candid 35mm lifestyle angle, product in hand or placed naturally in context, keep product clearly visible and not obscured.",
        "Lighting: warm natural window light with realistic shadows.",
        "Background: home, office, vanity, desk, car, or daily routine scene that matches the product category and target audience.",
        "Emotional tone: 'I can imagine owning this' feeling, useful, approachable, trustworthy.",
        "CTR strategy: create ownership desire and relatable problem-solution context without fake before-after claims."
      ].join(" ")
    },
    {
      concept: "close_up_detail",
      title: "Prompt 3: Detail Close-up",
      prompt: [
        header,
        "IMAGE 3 CLOSE-UP DETAIL: macro/detail-focused composition that highlights one real visible feature or material detail.",
        "Camera: close-up crop, shallow depth of field, focus on texture, button, lid, edge, surface, packaging detail, material, or functional part that actually belongs to the product.",
        "Lighting: controlled highlight to reveal quality and texture without over-polishing.",
        "Background: minimal blurred background with product-color harmony.",
        "Emotional tone: quality, confidence, 'this looks worth it'.",
        "CTR strategy: make users curious about the feature and want to tap for details; do not invent hidden specs or impossible functions."
      ].join(" ")
    },
    {
      concept: "viral_review_style",
      title: "Prompt 4: Viral Review Style",
      prompt: [
        header,
        "IMAGE 4 VIRAL REVIEW STYLE: Facebook-native review aesthetic with a wow-effect composition while keeping the product realistic.",
        "Camera: dynamic angled shot, product foregrounded, subtle reaction/context elements around it, no fake screenshots or fabricated review cards.",
        "Lighting: bright scroll-stopping social media lighting, clear product edges, high readability.",
        "Background: Thai Facebook deal/review vibe, clean table setup or lifestyle flat lay, small graphic accents allowed but no fake logos.",
        "Emotional tone: exciting, shareable, trustworthy, 'people are talking about this' feeling without claiming fake social proof.",
        "CTR strategy: strong contrast, curiosity-driven layout, product remains the hero, safe space for punchy Thai overlay text."
      ].join(" ")
    }
  ];

  return {
    productVisualAnalysis: analysis,
    consistencyInstructions,
    prompts,
    negativePrompt: [
      "Do not change product shape, color, branding, logo, label, category, accessories, packaging, or visible components.",
      "No random redesigns, no fake luxury transformation, no fake celebrity endorsement, no fake Shopee logo, no fake reviews or screenshots.",
      "No misleading health, medical, financial, safety, or guaranteed-result claims.",
      "No unrealistic anatomy, distorted hands, mutated product, impossible materials, unreadable fake text, duplicate products, extra product variants, or unrelated items.",
      "Do not make the product look like a different model, size, colorway, or brand."
    ].join(" ")
  };
}

export function buildShopeeImagePrompt(product: ShopeeProductRecord, style: ShopeeCaptionStyle = "soft_sell") {
  return buildShopeeImagePromptSet(product, style).prompts[0].prompt;
}
