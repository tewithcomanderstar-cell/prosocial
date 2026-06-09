import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import {
  buildAffiliateLinkCore,
  buildShopeeImagePrompt,
  buildShopeeImagePromptSet,
  countShopeeProductNameOccurrences,
  isShopeeProductNameDuplicateText,
  MockShopeeProvider,
  removeDuplicateShopeeProductNameLines,
  scoreShopeeProduct
} from "./shopee-affiliate-core.ts";
// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import type { ShopeeProductRecord } from "./shopee-affiliate-core.ts";
// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import { getShopeeCategoryLabel, normalizeShopeeCategories, normalizeShopeeCategory } from "../shopee-categories.ts";

const sampleProduct: ShopeeProductRecord = {
  productId: "test-product",
  shopId: "shop-1",
  itemId: "item-1",
  productName: "Thermal cup",
  productDescription: "Keeps drinks cold and is easy to carry",
  productPrice: 299,
  discountPrice: 159,
  discountPercent: 47,
  productImageUrl: "https://example.com/image.jpg",
  productUrl: "https://shopee.co.th/product/shop-1/item-1",
  category: "Lifestyle",
  salesCount: 12000,
  rating: 4.9,
  commissionRate: 8,
  sourceTag: "trending",
  fetchedAt: new Date("2026-05-17T00:00:00.000Z")
};

function readShopeeAffiliateServiceSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "shopee-affiliate.ts"), "utf8");
}

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

async function testMockProviderReturnsProducts() {
  const provider = new MockShopeeProvider();
  const products = await provider.fetchProducts({ sourceTag: "trending", limit: 2 });

  assert.equal(products.length, 2);
  assert.equal(products[0].sourceTag, "trending");
  assert.ok(products[0].productName.length > 0);
  console.log("PASS Shopee mock provider returns products");
}

function testScoringRewardsStrongProducts() {
  const score = scoreShopeeProduct({ product: sampleProduct, categoryPriority: ["Lifestyle"] });

  assert.ok(score.productScore >= 80);
  assert.ok(score.reason.length >= 2);
  assert.deepEqual(score.riskFlags, []);
  console.log("PASS Shopee scoring rewards strong products");
}

function testShopeeCategoryNormalization() {
  assert.equal(normalizeShopeeCategory("Lifestyle, Beauty, Home"), "all");
  assert.equal(normalizeShopeeCategory("Home & Living"), "home_living");
  assert.deepEqual(normalizeShopeeCategories(["Automotive", "Sports & Outdoors"]), ["automotive", "sports"]);
  assert.deepEqual(normalizeShopeeCategories(["all", "Automotive", "Sports & Outdoors"]), []);
  assert.deepEqual(normalizeShopeeCategories([]), []);
  assert.equal(getShopeeCategoryLabel("beauty"), "Beauty & Personal Care");
  console.log("PASS Shopee category dropdown values normalize legacy text");
}

function testScoringBlocksRecentDuplicates() {
  const score = scoreShopeeProduct({ product: sampleProduct, recentlyPosted: true });

  assert.ok(score.productScore < 60);
  assert.ok(score.riskFlags.includes("recent_duplicate"));
  console.log("PASS Shopee scoring penalizes recent duplicates");
}

function testAffiliateLinkBuilderAddsTracking() {
  const link = buildAffiliateLinkCore({ product: sampleProduct, trackingId: "page-abc" });
  const url = new URL(link);

  assert.equal(url.searchParams.get("utm_source"), "prosocial");
  assert.equal(url.searchParams.get("utm_medium"), "affiliate_auto_post");
  assert.equal(url.searchParams.get("utm_content"), "page-abc");
  console.log("PASS Shopee affiliate link builder adds tracking");
}

function testAffiliateLinkBuilderOmitsSubIds() {
  const link = buildAffiliateLinkCore({
    product: sampleProduct,
    trackingId: "track-main",
    affiliateBaseUrl: "https://s.shopee.co.th/example"
  });
  const url = new URL(link);

  assert.equal(url.searchParams.get("tracking_id"), "track-main");
  assert.equal(new URL(link).searchParams.has("sub_id"), false);
  assert.equal(new URL(link).searchParams.has("sub_id1"), false);
  console.log("PASS Shopee affiliate link builder omits Sub ID fields");
}

function testProductNameDuplicateDetection() {
  const productName = "ขนมเปี๊ยะไส้ไก่หยอง และ ขนมเปี๊ยะหมูหยอง M&D";

  assert.equal(isShopeeProductNameDuplicateText(productName, productName), true);
  assert.equal(isShopeeProductNameDuplicateText(`✅ ${productName}`, productName), true);
  assert.equal(isShopeeProductNameDuplicateText("✅ มี 2 รสในกล่องเดียว", productName), false);
  console.log("PASS Shopee caption detects duplicate product name text");
}

function testDuplicateProductNameLineRemoval() {
  const productName = "ขนมเปี๊ยะไส้ไก่หยอง และ ขนมเปี๊ยะหมูหยอง M&D";
  const cleaned = removeDuplicateShopeeProductNameLines(
    [
      productName,
      `✅ ${productName}`,
      "✅ มี 2 รสในกล่องเดียว",
      "📍 พิกัด https://s.shopee.co.th/example"
    ],
    productName
  );

  assert.deepEqual(cleaned, [productName, "✅ มี 2 รสในกล่องเดียว", "📍 พิกัด https://s.shopee.co.th/example"]);
  console.log("PASS Shopee caption removes duplicate product-name lines");
}

function testProductNameOccurrenceCounting() {
  const productName = "ขนมเปี๊ยะไส้ไก่หยอง และ ขนมเปี๊ยะหมูหยอง M&D";
  const caption = `${productName}\n\n✅ ${productName}\n\nhttps://s.shopee.co.th/example`;

  assert.equal(countShopeeProductNameOccurrences(caption, productName), 2);
  console.log("PASS Shopee caption counts product name occurrences");
}

function testImagePromptIncludesSafetyRules() {
  const prompt = buildShopeeImagePrompt(sampleProduct, "deal_alert");

  assert.ok(prompt.includes(sampleProduct.productName));
  assert.ok(prompt.includes("fake Shopee UI") || prompt.includes("fake product"));
  assert.ok(prompt.includes("Do not invent a new product"));
  console.log("PASS Shopee image prompt includes safety rules");
}

function testImagePromptSetCreatesFourConsistentPrompts() {
  const promptSet = buildShopeeImagePromptSet(sampleProduct, "deal_alert");

  assert.equal(promptSet.prompts.length, 4);
  assert.deepEqual(
    promptSet.prompts.map((item) => item.concept),
    ["hero_product_shot", "close_up_detail", "lifestyle_usage", "viral_review_style"]
  );
  for (const item of promptSet.prompts) {
    assert.ok(item.prompt.includes(sampleProduct.productName));
    assert.ok(item.prompt.includes("Product image reference URL"));
    assert.ok(item.prompt.includes("source of truth"));
    assert.ok(item.prompt.includes("No readable text should be generated by the image model"));
    assert.ok(item.prompt.includes("Do not add any new explanatory text"));
  }
  assert.ok(promptSet.negativePrompt.includes("no fake product"));
  assert.ok(promptSet.negativePrompt.includes("no mutated brand label"));
  assert.ok(promptSet.negativePrompt.includes("no text box"));
  console.log("PASS Shopee image prompt set creates 4 consistent CTR prompts");
}

function testStoryboardCaptionSourceUsesProductEntityGuards() {
  const source = readShopeeAffiliateServiceSource();
  const entitySource = sourceBetween(source, "function extractShopeeProductEntity", "function getShopeeStoryboardInputText");
  const groupSource = sourceBetween(source, "function getShopeeStoryboardProductGroup", "function enrichShopeeStoryboardForAffiliateReview");
  const captionSource = sourceBetween(source, "function buildShopeeStoryboardCaption", "function createValidatedShopeeProductStoryboard");
  const validationSource = sourceBetween(source, "const SHOPEE_GENERIC_CAPTION_TEMPLATE_PATTERN", "function getStoryboardCaptionDebugPayload");

  assert.ok(entitySource.includes("กระบอกน้ำ"));
  assert.ok(entitySource.includes("พกน้ำหรือเครื่องดื่มไปทำงาน เดินทาง หรือออกกำลังกาย"));
  assert.ok(entitySource.includes("เสื้อ"));
  assert.ok(entitySource.includes("ใส่แมตช์กับกางเกงหรือกระโปรง"));
  assert.ok(groupSource.includes('return "generic_product"'));
  const groupReturns = Array.from(groupSource.matchAll(/return "([^"]+)";/g)).map((match) => match[1]);
  assert.equal(groupReturns.at(-1), "generic_product");
  assert.ok(captionSource.includes("buildShopeeStoryboardSolutionLine"));
  assert.equal(captionSource.includes("มีตัวช่วยไว้สะดวกกว่าเดิม"), false);
  assert.ok(source.includes("NO_GENERIC_CATEGORY_TEMPLATE"));
  for (const phrase of ["ของใช้ในบ้าน", "หยิบใช้", "ช่วยให้บ้านดูใช้งานง่าย", "ช่วงใช้งานในชีวิตประจำวัน"]) {
    assert.ok(validationSource.includes(phrase), `Missing generic phrase validation for ${phrase}`);
  }
  console.log("PASS Shopee storyboard caption source uses product-entity guards");
}

await testMockProviderReturnsProducts();
testShopeeCategoryNormalization();
testScoringRewardsStrongProducts();
testScoringBlocksRecentDuplicates();
testAffiliateLinkBuilderAddsTracking();
testAffiliateLinkBuilderOmitsSubIds();
testProductNameDuplicateDetection();
testDuplicateProductNameLineRemoval();
testProductNameOccurrenceCounting();
testImagePromptIncludesSafetyRules();
testImagePromptSetCreatesFourConsistentPrompts();
testStoryboardCaptionSourceUsesProductEntityGuards();
