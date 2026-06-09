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

function readAiServiceSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "ai.ts"), "utf8");
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
  const enrichSource = sourceBetween(source, "function enrichShopeeStoryboardForAffiliateReview", "const SHOPEE_STORYBOARD_RULES");
  const captionSource = sourceBetween(source, "function buildShopeeStoryboardCaption", "function createValidatedShopeeProductStoryboard");
  const validationSource = sourceBetween(source, "const SHOPEE_GENERIC_CAPTION_TEMPLATE_PATTERN", "function getStoryboardCaptionDebugPayload");
  assert.ok(source.includes("type ShopeeProductUnderstanding"));
  assert.ok(source.includes("PRODUCT_UNDERSTANDING_FAILED"));
  assert.ok(source.includes("PRODUCT_UNDERSTANDING_DEBUG"));
  assert.ok(source.includes("getShopeeProductUnderstandingDebugPayload"));
  assert.ok(source.includes("descriptionSnippet"));
  assert.ok(source.includes("missingFields"));
  assert.ok(source.includes("imageCount"));
  assert.ok(entitySource.includes("travel_pillow"));
  assert.ok(entitySource.includes("water_purifier_accessory"));
  assert.ok(entitySource.includes("sport_shirt"));

  assert.ok(entitySource.includes("กระบอกน้ำ"));
  assert.ok(entitySource.includes("พกน้ำหรือเครื่องดื่มไปทำงาน เดินทาง หรือออกกำลังกาย"));
  assert.ok(entitySource.includes("เสื้อ"));
  assert.ok(entitySource.includes("ใส่แมตช์กับกางเกงหรือกระโปรง"));
  assert.ok(groupSource.includes('return "generic_product"'));
  const groupReturns = Array.from(groupSource.matchAll(/return "([^"]+)";/g)).map((match) => match[1]);
  assert.equal(groupReturns.at(-1), "generic_product");
  assert.equal(enrichSource.includes("home: {"), false);
  assert.equal(enrichSource.includes("generic_product: {"), false);
  assert.ok(captionSource.includes("buildShopeeStoryboardSolutionLine"));
  assert.ok(captionSource.includes("buildShopeeStoryboardCtaLine"));
  assert.equal(captionSource.includes("มีตัวช่วยไว้สะดวกกว่าเดิม"), false);
  assert.ok(source.includes("NO_GENERIC_CATEGORY_TEMPLATE"));
  assert.ok(source.includes("ENTITY_SPECIFIC_LANGUAGE"));
  assert.ok(source.includes("isShopeeHashtagRelevantToStoryboard"));
  assert.equal(source.includes("audienceTags"), false);
  for (const phrase of ["ของใช้ในบ้าน", "หยิบใช้", "ช่วยให้บ้านดูใช้งานง่าย", "ช่วงใช้งานในชีวิตประจำวัน"]) {
    assert.ok(validationSource.includes(phrase), `Missing generic phrase validation for ${phrase}`);
  }
  console.log("PASS Shopee storyboard caption source uses product-entity guards");
}

function testShopeeSourceSpecificSelectionGuards() {
  const source = readShopeeAffiliateServiceSource();
  const scoringSource = sourceBetween(source, "export function scoreShopeeProductForSource", "function sourceSpecificRankedSelection");
  const selectionSource = sourceBetween(source, "function sourceSpecificRankedSelection", "export async function selectShopeeProductsForPages");

  assert.ok(scoringSource.includes("salesScore*0.60 + reviewScore*0.20 + ratingScore*0.15 + productQualityScore*0.05"));
  assert.ok(scoringSource.includes("estimatedCommissionScore*0.45 + conversionProxy*0.45 + productQualityScore*0.10"));
  assert.ok(scoringSource.includes("keywordMatchScore*0.35 + salesScore*0.25 + reviewScore*0.15 + ratingScore*0.10 + sourceApiBonus*0.15"));
  assert.ok(scoringSource.includes("exactKeywordMatch*0.40 + partialKeywordMatch*0.20 + categoryMatch*0.10 + salesScore*0.15 + ratingScore*0.10 + commissionScore*0.05"));
  assert.ok(selectionSource.includes("pickRandomTopSourceCandidate"));
  assert.ok(source.includes("SHOPEE_SOURCE_SCORE_BREAKDOWN"));
  assert.ok(source.includes("manual_keyword_required"));
  assert.ok(source.includes("listType_requires_matchId_but_matchId_missing"));
  assert.equal(source.includes("function weightedRandomProduct"), false);
  console.log("PASS Shopee source-specific selection guards");
}

function testProductUnderstandingMainUseCaseCoverage() {
  const source = readShopeeAffiliateServiceSource();
  const librarySource = sourceBetween(source, "const SHOPEE_PRODUCT_TYPE_LIBRARY", "const SHOPEE_KNOWN_PRODUCT_TYPES");
  const mappingSource = sourceBetween(source, "const SHOPEE_MAIN_USE_CASE_BY_PRODUCT_TYPE", "let shopeeProductUnderstandingCoverageLogged");
  const extractionSource = sourceBetween(source, "function extractShopeeProductUnderstanding", "function getShopeeProductUnderstandingDebugPayload");
  const requiredProductTypes = [
    "scented_candle",
    "waterproof_tablecloth",
    "storage_box",
    "shoe_rack",
    "pet_feeder",
    "pet_bed",
    "travel_bottle",
    "thermal_cup",
    "apparel",
    "sport_shirt",
    "skincare",
    "drinkware",
    "travel_pillow",
    "home_storage",
    "kitchenware",
    "pet_supply",
    "automotive_accessory",
    "electronics_accessory",
    "beauty_tool",
    "jewelry",
    "necklace",
    "earring",
    "bracelet",
    "wallet",
    "backpack",
    "handbag",
    "car_phone_holder",
    "car_vacuum",
    "phone_case",
    "charging_cable",
    "power_bank",
    "kitchen_container",
    "ice_tray",
    "water_filter",
    "bag",
    "shoes",
    "food"
  ];
  const productTypeMatches = Array.from(librarySource.matchAll(/\["([a-z0-9_]+)",/g)).map((match) => match[1]);
  const uniqueProductTypes = new Set(productTypeMatches);
  assert.ok(uniqueProductTypes.size >= 100, `Expected at least 100 product types, found ${uniqueProductTypes.size}`);

  for (const productType of requiredProductTypes) {
    assert.ok(uniqueProductTypes.has(productType), `Missing productType library entry ${productType}`);
  }
  for (const profileField of ["mainUseCase", "targetAudience", "painPoint", "dailyBenefit"]) {
    assert.ok(librarySource.includes(profileField), `Missing Product Type Library field ${profileField}`);
  }
  assert.ok(mappingSource.includes("SHOPEE_PRODUCT_TYPE_LIBRARY.map((item) => [item.productType, item.mainUseCase])"));
  assert.ok(source.includes("PRODUCT_UNDERSTANDING_COVERAGE_REPORT"));
  assert.ok(source.includes("PRODUCT_UNDERSTANDING_AUDIT"));
  assert.ok(source.includes("TEXT_UNDERSTANDING_RESULT"));
  assert.ok(source.includes("VISION_RESCUE_TRIGGERED"));
  assert.ok(source.includes("VISION_UNDERSTANDING_RESULT"));
  assert.ok(source.includes("VISION_RESCUE_FAILED"));
  assert.ok(source.includes("PRODUCT_UNDERSTANDING_MERGED"));
  assert.ok(source.includes("VISION_RESCUE_TIMEOUT_MS = 30_000"));
  assert.ok(source.includes("productUnderstanding.confidence < 80"));
  assert.ok(source.includes("getFirstValidShopeeProductImageUrl"));
  assert.ok(source.includes("analyzeShopeeProductImageUnderstanding"));
  assert.ok(source.includes("coverageReport"));
  assert.ok(source.includes("missingMainUseCaseMapping"));
  assert.ok(source.includes("incompleteProductTypeProfiles"));
  assert.ok(source.includes("getShopeeEntityBasedMainUseCase"));
  assert.ok(source.includes("ใช้เพิ่มกลิ่นหอมภายในห้อง"));
  assert.ok(source.includes("ใช้ปูโต๊ะเพื่อกันน้ำและคราบเปื้อน"));
  assert.ok(source.includes("getShopeeProductUnderstandingAuditPayload"));
  assert.ok(source.includes("captionInput"));
  assert.ok(extractionSource.includes("mappedMainUseCase"));
  assert.ok(extractionSource.includes("entityBridgeMainUseCase"));
  assert.ok(extractionSource.includes("imageCount > 0"));
  assert.ok(extractionSource.includes("fallbackUsed"));
  assert.ok(extractionSource.includes("recognitionStatus"));
  assert.ok(source.includes("function humanizeShopeeStoryboardCaptionLine"));
  assert.ok(source.includes("entityBridgeMatch"));
  console.log("PASS Shopee product understanding mainUseCase coverage");
}

function testShopeeVisionRescueUsesActualImageInput() {
  const source = readAiServiceSource();
  const visionSource = sourceBetween(source, "export async function analyzeShopeeProductImageUnderstanding", "export async function generateOptimizationSuggestions");
  assert.ok(visionSource.includes("{ type: \"input_image\", image_url: input.imageUrl, detail: \"high\" }"));
  assert.ok(visionSource.includes("Analyze this Shopee product image"));
  assert.ok(visionSource.includes("visionProductEntity"));
  assert.ok(visionSource.includes("visionProductType"));
  assert.ok(visionSource.includes("visionMainUseCase"));
  assert.ok(visionSource.includes("visionTargetAudience"));
  assert.ok(visionSource.includes("visionConfidence"));
  assert.ok(visionSource.includes("visualEvidence"));
  assert.ok(visionSource.includes("controller.abort"));
  console.log("PASS Shopee vision rescue uses actual image input");
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
testShopeeSourceSpecificSelectionGuards();
testProductUnderstandingMainUseCaseCoverage();
testShopeeVisionRescueUsesActualImageInput();
