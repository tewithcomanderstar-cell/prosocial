import assert from "node:assert/strict";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import {
  buildAffiliateLinkCore,
  buildShopeeImagePrompt,
  buildShopeeImagePromptSet,
  countShopeeProductNameOccurrences,
  isShopeeProductNameDuplicateText,
  MockShopeeProvider,
  removeDuplicateShopeeProductNameLines,
  scoreShopeeProduct,
  SHOPEE_SUB_ID_ERROR_MESSAGE
} from "./shopee-affiliate-core.ts";
// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import type { ShopeeProductRecord } from "./shopee-affiliate-core.ts";

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

function testAffiliateLinkBuilderAddsSubIds() {
  const link = buildAffiliateLinkCore({
    product: sampleProduct,
    trackingId: "track-main",
    affiliateBaseUrl: "https://s.shopee.co.th/example",
    subIds: {
      subId: "fb_page_test",
      subId1: "campaign_may"
    }
  });
  const url = new URL(link);

  assert.equal(url.searchParams.get("tracking_id"), "track-main");
  assert.equal(url.searchParams.get("sub_id"), "fb_page_test");
  assert.equal(url.searchParams.get("sub_id1"), "campaign_may");
  console.log("PASS Shopee affiliate link builder adds Sub ID fields");
}

function testAffiliateLinkBuilderCreatesUniqueLinksForPageSubIds() {
  const pageSubIds = ["page_a", "page_b", "page_c", "page_d"];
  const links = pageSubIds.map((subId) =>
    buildAffiliateLinkCore({
      product: sampleProduct,
      affiliateBaseUrl: "https://s.shopee.co.th/example",
      subIds: { subId }
    })
  );

  assert.equal(new Set(links).size, 4);
  for (const [index, link] of links.entries()) {
    assert.equal(new URL(link).searchParams.get("sub_id"), pageSubIds[index]);
  }
  console.log("PASS Shopee affiliate link builder creates one short-link payload per page Sub ID");
}

function testAffiliateLinkBuilderRejectsInvalidSubId() {
  assert.throws(
    () => buildAffiliateLinkCore({ product: sampleProduct, subIds: { subId: "bad value" } }),
    new RegExp(SHOPEE_SUB_ID_ERROR_MESSAGE)
  );
  console.log("PASS Shopee affiliate link builder rejects invalid Sub ID");
}

function testAffiliateLinkBuilderAllowsBlankSubId() {
  const link = buildAffiliateLinkCore({
    product: sampleProduct,
    affiliateBaseUrl: "https://s.shopee.co.th/example",
    subIds: { subId: "" }
  });

  assert.equal(new URL(link).searchParams.has("sub_id"), false);
  console.log("PASS Shopee affiliate link builder allows blank Sub ID");
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

await testMockProviderReturnsProducts();
testScoringRewardsStrongProducts();
testScoringBlocksRecentDuplicates();
testAffiliateLinkBuilderAddsTracking();
testAffiliateLinkBuilderAddsSubIds();
testAffiliateLinkBuilderCreatesUniqueLinksForPageSubIds();
testAffiliateLinkBuilderRejectsInvalidSubId();
testAffiliateLinkBuilderAllowsBlankSubId();
testProductNameDuplicateDetection();
testDuplicateProductNameLineRemoval();
testProductNameOccurrenceCounting();
testImagePromptIncludesSafetyRules();
testImagePromptSetCreatesFourConsistentPrompts();
