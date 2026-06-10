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

function readAutoPostServiceSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "auto-post.ts"), "utf8");
}

function readAutoPostProcessStepRouteSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../app/api/auto-post/process-step/route.ts"), "utf8");
}

function readAutoPostStatusRouteSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../app/api/auto-post/status/route.ts"), "utf8");
}

function readAutoPostPanelSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../components/auto-post-panel.tsx"), "utf8");
}

function readQueueServiceSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "queue.ts"), "utf8");
}

function readAutoPostRouteSource() {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../app/api/auto-post/route.ts"), "utf8");
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
  assert.ok(source.includes("FALLBACK_PRODUCT_SELECTION_USED"));
  assert.ok(source.includes("shopee_no_eligible_products"));
  assert.ok(source.includes("getShopeeProductHardSelectionRejectionReason"));
  assert.ok(source.includes("fallback_relaxed_selection"));
  assert.ok(source.includes("PRODUCT_SELECTION_ROOT_CAUSE"));
  assert.ok(source.includes("all_products"));
  assert.ok(source.includes("fetchShopeeAllProductsForSelectedCategories"));
  assert.ok(source.includes("SHOPEE_ALL_PRODUCTS_FETCH_STARTED"));
  assert.ok(source.includes("SHOPEE_ALL_PRODUCTS_CATEGORY_FETCHED"));
  assert.ok(source.includes("SHOPEE_ALL_PRODUCTS_FETCH_COMPLETED"));
  assert.ok(source.includes("getRecentlyPostedProductKeys"));
  assert.ok(source.includes("SHOPEE_REPOST_COOLDOWN_HOURS"));
  assert.ok(source.includes("duplicate_product_48h"));
  assert.ok(source.includes("reserved_product"));
  assert.ok(source.includes("PRODUCT_RESERVED"));
  assert.ok(source.includes("PRODUCT_RESERVATION_RELEASED"));
  assert.ok(source.includes("DUPLICATE_PRODUCT_SKIPPED_48H"));
  assert.ok(source.includes("RECENT_PRODUCT_EXCLUSION_APPLIED"));
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

function testShopeeCaptionHumanReadabilityGuards() {
  const source = readShopeeAffiliateServiceSource();
  const validationSource = sourceBetween(source, "function getShopeeCaptionHumanReadabilityIssueDetails", "function getStoryboardCaptionDebugPayload");
  const repairSource = sourceBetween(source, "function repairStoryboardAffiliateCaption", "type StoryboardCaptionFailedRule");
  const autoPostSource = readAutoPostServiceSource();
  assert.ok(source.includes("CAPTION_HUMAN_READABILITY"));
  assert.ok(source.includes("CAPTION_READABILITY_FAILED"));
  assert.ok(source.includes("caption_readability_failed"));
  assert.ok(source.includes("normalizeShopeeHumanReadableEntityText"));
  assert.ok(source.includes("AB Roller"));
  assert.ok(source.includes("Type-C"));
  assert.ok(validationSource.includes("broken_parenthesis"));
  assert.ok(validationSource.includes("broken_square_bracket"));
  assert.ok(validationSource.includes("broken_curly_bracket"));
  assert.ok(validationSource.includes("product_entity_dangling_suffix"));
  assert.ok(validationSource.includes("repeated_product_entity"));
  assert.ok(validationSource.includes("metadata_fragment"));
  assert.ok(validationSource.includes("too_short_line"));
  assert.ok(validationSource.includes("unfinished_text"));
  assert.ok(repairSource.includes("humanizeShopeeCaptionBeforeValidation"));
  assert.ok(source.includes("removeDuplicateShopeeProductNameLines"));
  assert.ok(autoPostSource.includes("PRODUCT_SKIPPED_CAPTION_READABILITY_FAILED"));
  assert.ok(autoPostSource.includes("retry_with_next_product"));
  assert.ok(autoPostSource.includes("SKIPPED_PRODUCT_WITH_REASON"));
  assert.ok(autoPostSource.includes("productUnderstandingError"));
  assert.ok(autoPostSource.includes("captionGenerationError"));
  assert.ok(autoPostSource.includes("affiliateLinkError"));
  console.log("PASS Shopee caption human readability guards");
}

function testShopeeCaptionFallbackGenerationGuards() {
  const source = readShopeeAffiliateServiceSource();
  const aiSource = readAiServiceSource();
  const captionSource = sourceBetween(source, "function getShopeeCaptionPromptInput", "function createValidatedShopeeProductStoryboard");
  const generateSource = sourceBetween(source, "export async function generateShopeeCaption", "async function fetchShopeeReferenceImage");
  const statusSource = readAutoPostStatusRouteSource();
  const panelSource = readAutoPostPanelSource();

  assert.ok(aiSource.includes("generateThaiSocialProductCaption"));
  assert.ok(aiSource.includes("ThaiSocialCaptionResult"));
  assert.ok(aiSource.includes("Caption Style"));
  assert.ok(aiSource.includes("Thai Facebook review page"));
  assert.ok(aiSource.includes("ดูรายละเอียด/เช็กราคาได้ที่นี่"));
  assert.ok(aiSource.includes("อย่างน้อย 3 bullet lines"));
  assert.ok(aiSource.includes("story | question | before_after | friend_tip | shock_hook | list_benefit"));
  assert.ok(aiSource.includes("captionText"));
  assert.ok(aiSource.includes("genericWordsFound"));
  assert.ok(aiSource.includes("qualityScore"));
  assert.ok(aiSource.includes("ห้ามขึ้นต้นด้วยชื่อสินค้า"));
  assert.ok(captionSource.includes("generateThaiSocialProductCaption"));
  assert.ok(captionSource.includes("validateThaiSocialCaptionCandidate"));
  assert.ok(captionSource.includes("thai_social_caption_missing_review_bullets"));
  assert.ok(captionSource.includes("THAI_SOCIAL_CAPTION_USED"));
  assert.ok(captionSource.includes("THAI_SOCIAL_CAPTION_FAILED"));
  assert.ok(captionSource.indexOf("generateThaiSocialProductCaption") < captionSource.indexOf("CAPTION_RAW_OUTPUT"));
  assert.ok(captionSource.includes("productDescription"));
  assert.ok(captionSource.includes("keySellingPoints"));
  assert.ok(captionSource.includes("affiliateLink"));
  assert.ok(captionSource.includes("storyboardSummary"));
  assert.ok(captionSource.includes("promptLength"));
  assert.ok(captionSource.includes("rawResponseParseError"));
  assert.ok(captionSource.includes("captionValidationRule"));
  assert.ok(captionSource.includes("captionValidationReason"));
  assert.ok(captionSource.includes("offendingText"));
  assert.ok(captionSource.includes("sanitizeShopeeCaptionMetadataFragments"));
  assert.ok(captionSource.includes("SHOPEE_CAPTION_METADATA_LINE_PATTERN"));
  assert.ok(captionSource.includes("SHOPEE_CAPTION_JSON_METADATA_PATTERN"));
  assert.ok(captionSource.includes("buildDeterministicShopeeFallbackCaption"));
  assert.ok(captionSource.includes("ดูรายละเอียด/เช็กราคาได้ที่นี่"));
  assert.ok(captionSource.includes("CAPTION_PRIMARY_FAILED"));
  assert.ok(captionSource.includes("CAPTION_GENERATION_ERROR_DETAIL"));
  assert.ok(captionSource.includes("CAPTION_FALLBACK_RAW_OUTPUT"));
  assert.ok(captionSource.includes("CAPTION_FALLBACK_USED"));
  assert.ok(captionSource.includes("CAPTION_FALLBACK_FAILED"));
  assert.ok(captionSource.includes("throw fallbackError"));
  assert.ok(captionSource.includes("validateStoryboardAffiliateCaption(fallbackCaption"));
  assert.ok(captionSource.includes("formatShopeeStoryboardPriceLine(product, storyboard)"));
  assert.ok(captionSource.includes("formatShopeeShortLinkLine(affiliateLink)"));
  assert.ok(captionSource.includes("buildShopeeStoryboardCtaLine(storyboard)"));
  assert.ok(source.includes("caption_readability_failed"));
  assert.equal(captionSource.includes("สินค้าคุณภาพดี"), false);
  assert.equal(captionSource.includes("คุ้มค่า คุ้มราคา"), false);
  assert.equal(captionSource.includes("เหมาะสำหรับทุกเพศทุกวัย"), false);
  assert.equal(captionSource.includes("ใช้งานได้หลากหลาย"), false);

  assert.ok(generateSource.includes("CAPTION_FALLBACK_USED"));
  assert.ok(generateSource.includes("CAPTION_PRIMARY_FAILED"));
  assert.ok(generateSource.includes("captionStatus: \"fallback_created\""));
  assert.ok(generateSource.includes("captionLastError"));
  assert.ok(generateSource.includes("captionValidationRule"));
  assert.ok(generateSource.includes("captionValidationReason"));
  assert.ok(generateSource.includes("offendingText"));
  assert.ok(generateSource.includes("CAPTION_CREATED"));
  assert.ok(generateSource.includes("captionResult?.fallbackUsed ? \"deterministic_fallback\""));
  assert.ok(generateSource.includes("promptLength"));
  assert.ok(generateSource.indexOf("CAPTION_FALLBACK_USED") < generateSource.indexOf("CAPTION_CREATED"));

  assert.ok(statusSource.includes("fallback_created"));
  assert.ok(statusSource.includes("CAPTION_FALLBACK_USED"));
  assert.ok(statusSource.includes("captionLastError"));
  assert.ok(statusSource.includes("captionProvider"));
  assert.ok(statusSource.includes("captionRetryCount"));
  assert.ok(statusSource.includes("captionValidationRule"));
  assert.ok(statusSource.includes("captionValidationReason"));
  assert.ok(statusSource.includes("captionOffendingText"));
  assert.ok(statusSource.includes("captionFallbackUsed"));
  assert.ok(panelSource.includes("captionLastError?: string | null"));
  assert.ok(panelSource.includes("captionValidationRule?: string | null"));
  assert.ok(panelSource.includes("captionValidationReason?: string | null"));
  assert.ok(panelSource.includes("offendingText?: string | null"));
  assert.ok(panelSource.includes("fallbackUsed?: boolean"));
  assert.ok(panelSource.includes("Caption provider"));
  assert.ok(panelSource.includes("Caption retry count"));
  assert.ok(panelSource.includes("Caption last error"));
  assert.ok(panelSource.includes("Caption validation rule"));
  assert.ok(panelSource.includes("Caption validation reason"));
  assert.ok(panelSource.includes("Caption offending text"));
  assert.ok(panelSource.includes("Caption fallback used"));
  console.log("PASS Shopee caption fallback generation guards");
}

function testShopeeProductIntelligenceLayerGuards() {
  const source = readShopeeAffiliateServiceSource();
  const aiSource = readAiServiceSource();
  const packageSource = sourceBetween(source, "export async function buildShopeePostPackage", "export async function recordShopeeQueueItem");
  const intelligenceSource = sourceBetween(source, "export type ShopeeProductIntelligence", "function getShopeeStoryboardInputText");
  const captionSource = sourceBetween(source, "function getShopeeCaptionPromptInput", "function createValidatedShopeeProductStoryboard");

  assert.ok(source.includes("Product Intelligence"));
  assert.ok(source.includes("PRODUCT_INTELLIGENCE_ANALYSIS_STARTED"));
  assert.ok(source.includes("PRODUCT_INTELLIGENCE_ANALYSIS_COMPLETED"));
  assert.ok(source.includes("PRODUCT_INTELLIGENCE_ANALYSIS_FAILED"));
  assert.ok(source.includes("product_intelligence_failed"));
  assert.ok(intelligenceSource.includes("productName"));
  assert.ok(intelligenceSource.includes("productNameThai"));
  assert.ok(intelligenceSource.includes("productNameOriginal"));
  assert.ok(intelligenceSource.includes("canonicalProductKey"));
  assert.ok(intelligenceSource.includes("brand"));
  assert.ok(intelligenceSource.includes("category"));
  assert.ok(intelligenceSource.includes("productType"));
  assert.ok(intelligenceSource.includes("mainPurpose"));
  assert.ok(intelligenceSource.includes("targetCustomer"));
  assert.ok(intelligenceSource.includes("usageScenarios"));
  assert.ok(intelligenceSource.includes("keyBenefits"));
  assert.ok(intelligenceSource.includes("uniqueSellingPoints"));
  assert.ok(intelligenceSource.includes("productFacts"));
  assert.ok(intelligenceSource.includes("imageProductSummary"));
  assert.ok(intelligenceSource.includes("painPoint"));
  assert.ok(intelligenceSource.includes("triggerMoment"));
  assert.ok(intelligenceSource.includes("humanVoice"));
  assert.ok(intelligenceSource.includes("contentTone"));
  assert.ok(intelligenceSource.includes("lowConfidenceReason"));
  assert.ok(intelligenceSource.includes("confidenceScore"));
  assert.ok(intelligenceSource.includes("intelligence.confidence < 70"));
  assert.ok(source.includes("analyzeThaiBuyerProductIntelligence"));
  assert.ok(source.includes("THAI_BUYER_PRODUCT_INTELLIGENCE_COMPLETED"));
  assert.ok(source.includes("THAI_BUYER_PRODUCT_INTELLIGENCE_FAILED"));
  assert.ok(source.includes("PRODUCT_INTELLIGENCE_CONFIDENCE_RESCUED"));
  assert.ok(source.includes("Math.max(base.confidence, thaiBuyerConfidence)"));
  assert.ok(source.includes("baseConfidenceBeforeThaiBuyer"));
  assert.ok(source.includes("finalConfidence"));
  assert.ok(source.includes("mergeThaiBuyerProductIntelligence"));
  assert.ok(aiSource.includes("ThaiBuyerProductIntelligenceResult"));
  assert.ok(aiSource.includes("You are a Thai consumer psychologist and product analyst"));
  assert.ok(aiSource.includes("Return ONLY a valid JSON object"));
  assert.ok(aiSource.includes("painPoint"));
  assert.ok(aiSource.includes("triggerMoment"));
  assert.ok(aiSource.includes("humanVoice"));
  assert.ok(aiSource.includes("lowConfidenceReason"));
  assert.ok(aiSource.includes("generateThaiLifestyleImagePrompt"));
  assert.ok(aiSource.includes("ThaiLifestyleImagePromptResult"));
  assert.ok(aiSource.includes("creative director for Thai lifestyle social media content"));
  assert.ok(aiSource.includes("fullPrompt ต้องเป็นภาษาอังกฤษ"));
  assert.ok(aiSource.includes("matchesCaptionMood"));
  assert.ok(aiSource.includes("คุณภาพดี"));
  assert.ok(aiSource.includes("คุ้มค่า"));
  assert.ok(source.includes("PRODUCT_UNDERSTANDING_LOW_CONFIDENCE"));
  assert.ok(source.includes("product_understanding_low_confidence"));
  assert.ok(source.includes("getShopeeNaturalThaiProductNameFromSlug"));
  assert.ok(source.includes("waterproof_tablecloth"));
  assert.ok(source.includes("scented_candle"));
  assert.ok(intelligenceSource.includes("missing_real_use_case"));
  assert.ok(intelligenceSource.includes("missing_real_benefit"));
  assert.ok(intelligenceSource.includes("missing_target_customer"));
  assert.ok(intelligenceSource.includes("SHOPEE_FORBIDDEN_PRODUCT_INTELLIGENCE_PHRASE_PATTERN"));
  for (const phrase of [
    "ใช้ตามลักษณะสินค้าที่ระบุ",
    "ใช้งานได้หลากหลาย",
    "เหมาะสำหรับทุกเพศทุกวัย",
    "ใช้ได้ตรงกับจุดประสงค์มากขึ้น",
    "เลือกใช้ได้ตรงกับประเภทสินค้า"
  ]) {
    assert.ok(source.includes(phrase), `Missing forbidden Product Intelligence phrase guard: ${phrase}`);
  }
  assert.ok(captionSource.includes("productIntelligence"));
  assert.ok(packageSource.includes("createShopeeProductIntelligenceWithTracing"));
  assert.ok(packageSource.includes("applyShopeeProductIntelligence"));
  assert.ok(source.includes("resolveThaiSocialCaptionStyle"));
  assert.ok(source.includes("isSpecificThaiTargetCustomer"));
  assert.ok(source.includes("auto_emotion_heavy"));
  assert.ok(source.includes("auto_sold_count_gt_1000"));
  assert.ok(source.includes("auto_specific_target_customer"));
  assert.ok(source.includes("auto_default_story"));
  assert.ok(source.includes("CAPTION_STYLE_RESOLVED"));
  assert.ok(source.includes("socialCaptionStyle"));
  assert.ok(captionSource.includes("styleSource"));
  assert.ok(captionSource.includes("package_resolved"));
  assert.ok(packageSource.indexOf("createShopeeProductIntelligenceWithTracing") < packageSource.indexOf("generateShopeeCaption"));
  assert.ok(packageSource.indexOf("generateShopeeCaption") < packageSource.indexOf("buildLifestyleAwareShopeeImagePromptSet"));
  assert.ok(packageSource.indexOf("CAPTION_STYLE_RESOLVED") < packageSource.indexOf("generateShopeeCaption"));
  assert.ok(packageSource.indexOf("CAPTION_STYLE_RESOLVED") < packageSource.indexOf("buildLifestyleAwareShopeeImagePromptSet"));
  assert.ok(packageSource.includes("socialCaptionStyle: resolvedCaptionStyle.style"));
  assert.ok(packageSource.includes("CAPTION_IMAGE_PRODUCT_MISMATCH"));
  assert.ok(packageSource.includes("CAPTION_IMAGE_PRODUCT_MATCHED"));
  assert.ok(packageSource.includes("captionProductId"));
  assert.ok(packageSource.includes("imageProductId"));
  assert.ok(packageSource.includes("captionCanonicalProductKey"));
  assert.ok(packageSource.includes("imageCanonicalProductKey"));
  assert.ok(packageSource.includes("getShopeeCaptionImageProductMismatch"));
  assert.ok(packageSource.includes("productIntelligence"));
  assert.ok(source.includes("buildLifestyleAwareShopeeImagePromptSet"));
  assert.ok(source.includes("generateThaiLifestyleImagePrompt"));
  assert.ok(source.includes("THAI_LIFESTYLE_IMAGE_PROMPT_USED"));
  assert.ok(source.includes("THAI_LIFESTYLE_IMAGE_PROMPT_FAILED"));
  assert.ok(source.includes("appendLifestylePromptToShopeePromptSet"));
  assert.ok(source.includes("white background"));
  console.log("PASS Shopee Product Intelligence layer guards");
}

function testShopeeCaptionQualityAndSoldThresholdGuards() {
  const source = readShopeeAffiliateServiceSource();
  const panelSource = readAutoPostPanelSource();
  const routeSource = readAutoPostRouteSource();
  const autoPostSource = readAutoPostServiceSource();
  const fallbackSource = sourceBetween(source, "function buildDeterministicShopeeFallbackCaption", "function getShopeeCaptionHumanReadableLines");
  const autoPostRouteSchemaSource = sourceBetween(routeSource, "const schema = z.object", "const DEFAULT_POSTING_WINDOW_START");

  assert.ok(source.includes("SHOPEE_FORBIDDEN_PRODUCT_INTELLIGENCE_PHRASE_PATTERN"));
  assert.ok(source.includes("ดูรายละเอียดให้ตรงกับการใช้งานที่ต้องการ"));
  assert.ok(source.includes("เหมาะกับคนที่กำลังมองหา\\s*ใช้งานจริง"));
  assert.equal(fallbackSource.includes("เหมาะกับคนที่กำลังมองหา"), false);
  assert.ok(fallbackSource.includes("productNameThai"));
  assert.ok(fallbackSource.includes("mainPurpose"));
  assert.ok(fallbackSource.includes("targetCustomer"));
  assert.ok(fallbackSource.includes("usageScenarios"));
  assert.ok(fallbackSource.includes("keyBenefits"));

  for (const sourceTag of ["sold_500_plus", "sold_1000_plus", "sold_1500_plus", "sold_2000_plus"]) {
    assert.equal(source.includes(sourceTag), false, `SOLD filter must not be a Shopee source tag: ${sourceTag}`);
    assert.equal(panelSource.includes(`value="${sourceTag}"`), false, `SOLD filter must not appear in source dropdown: ${sourceTag}`);
    assert.equal(autoPostRouteSchemaSource.includes(sourceTag), false, `SOLD filter must not be accepted as API source tag: ${sourceTag}`);
  }
  for (const threshold of ["500", "1000", "1500", "2000"]) {
    assert.ok(panelSource.includes(`value={${threshold}}`), `Missing sold filter option ${threshold}`);
  }
  assert.ok(source.includes("below_min_sold_count"));
  assert.ok(source.includes("SOLD_COUNT_FILTER_APPLIED"));
  assert.ok(source.includes("PRODUCT_REJECTED_BELOW_MIN_SOLD"));
  assert.ok(source.includes("PRODUCT_ACCEPTED_SOLD_THRESHOLD"));
  assert.ok(source.includes("selectedSoldThreshold"));
  assert.ok(source.includes("productsAboveSoldThreshold"));
  assert.ok(source.includes("rejectedBelowSoldCount"));
  assert.ok(source.indexOf("below_min_sold_count") < source.indexOf("duplicate_product_48h"));
  assert.ok(panelSource.includes("SOLD 500+"));
  assert.ok(panelSource.includes("SOLD 1000+"));
  assert.ok(panelSource.includes("SOLD 1500+"));
  assert.ok(panelSource.includes("SOLD 2000+"));
  assert.ok(panelSource.includes("Sold Count Filter"));
  assert.ok(panelSource.includes("No sold filter"));
  assert.ok(panelSource.includes("shopeeMinSoldCount"));
  assert.ok(autoPostSource.includes("shopeeMinSoldCount"));
  assert.ok(autoPostSource.includes("product_understanding_low_confidence"));
  console.log("PASS Shopee caption quality and sold threshold guards");
}

function testShopeeAllProductsAndCooldownGuards() {
  const source = readShopeeAffiliateServiceSource();
  const panelSource = readAutoPostPanelSource();
  const routeSource = readAutoPostRouteSource();
  const queueSource = readQueueServiceSource();
  const packageSource = sourceBetween(source, "export async function recordShopeeQueueItem", "export async function logShopeeAutomationEvent");
  assert.ok(source.includes("all_products"));
  assert.ok(source.includes("fetchShopeeAllProductsForSelectedCategories"));
  assert.ok(source.includes("selectedCategoryIds"));
  assert.ok(source.includes("shuffleWithShopeeSeed"));
  assert.ok(source.includes("sortModes"));
  assert.ok(source.includes("dedupeShopeeProducts"));
  assert.ok(source.includes("getShopeeCanonicalProductKey"));
  assert.ok(source.includes("getRecentlyPostedProductKeys"));
  assert.ok(source.includes("lookbackHours"));
  assert.ok(source.includes("SHOPEE_REPOST_COOLDOWN_HOURS"));
  assert.ok(source.includes("getActiveReservedProductKeys"));
  assert.ok(source.includes("reserveShopeeProductKey"));
  assert.ok(source.includes("releaseShopeeProductReservation"));
  assert.ok(source.includes("ShopeeProductReservation"));
  assert.ok(source.includes("duplicate_product_48h"));
  assert.ok(source.includes("reserved_product"));
  assert.ok(source.includes("excludedRecent48h"));
  assert.ok(source.includes("excludedReserved"));
  assert.equal(packageSource.includes("ProductPostHistory.create"), false);
  assert.ok(queueSource.includes("POSTED_PRODUCT_HISTORY_SAVED"));
  assert.ok(queueSource.includes("status === \"published\""));
  assert.ok(queueSource.includes("ProductPostHistory.findOneAndUpdate"));
  assert.ok(queueSource.includes("releaseShopeeProductReservation"));
  assert.ok(panelSource.includes("All Products / สินค้าทั้งหมดในหมวดที่เลือก"));
  assert.ok(panelSource.includes("Selected categories"));
  assert.ok(panelSource.includes("allProductsCategoryMissing"));
  assert.ok(routeSource.includes("all_products_category_required"));
  console.log("PASS Shopee all_products cooldown and reservation guards");
}

function testAutoPostProcessStepNoEligibleProductsReturnsDiagnostics() {
  const source = readAutoPostProcessStepRouteSource();
  assert.ok(source.includes("shopee_no_eligible_products"));
  assert.ok(source.includes("diagnostics"));
  assert.ok(source.includes("NextResponse.json"));
  assert.ok(source.includes("responseSummary"));
  console.log("PASS auto-post process-step returns diagnostics for no eligible products");
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
testShopeeCaptionHumanReadabilityGuards();
testShopeeCaptionFallbackGenerationGuards();
testShopeeProductIntelligenceLayerGuards();
testShopeeCaptionQualityAndSoldThresholdGuards();
testShopeeAllProductsAndCooldownGuards();
testAutoPostProcessStepNoEligibleProductsReturnsDiagnostics();
