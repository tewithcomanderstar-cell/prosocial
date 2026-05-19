import assert from "node:assert/strict";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import { buildAffiliateLinkCore, buildShopeeImagePrompt, buildShopeeImagePromptSet, MockShopeeProvider, scoreShopeeProduct } from "./shopee-affiliate-core.ts";
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

function testImagePromptIncludesSafetyRules() {
  const prompt = buildShopeeImagePrompt(sampleProduct, "deal_alert");

  assert.ok(prompt.includes(sampleProduct.productName));
  assert.ok(prompt.includes("Shopee logos") || prompt.includes("fake logos"));
  assert.ok(prompt.includes("misleading"));
  console.log("PASS Shopee image prompt includes safety rules");
}

function testImagePromptSetCreatesFourConsistentPrompts() {
  const promptSet = buildShopeeImagePromptSet(sampleProduct, "deal_alert");

  assert.equal(promptSet.prompts.length, 4);
  assert.deepEqual(
    promptSet.prompts.map((item) => item.concept),
    ["hero_product_shot", "lifestyle_usage", "close_up_detail", "viral_review_style"]
  );
  for (const item of promptSet.prompts) {
    assert.ok(item.prompt.includes(sampleProduct.productName));
    assert.ok(item.prompt.includes("Reference product image URL"));
    assert.ok(item.prompt.includes("same"));
  }
  assert.ok(promptSet.negativePrompt.includes("Do not change product shape"));
  console.log("PASS Shopee image prompt set creates 4 consistent CTR prompts");
}

await testMockProviderReturnsProducts();
testScoringRewardsStrongProducts();
testScoringBlocksRecentDuplicates();
testAffiliateLinkBuilderAddsTracking();
testImagePromptIncludesSafetyRules();
testImagePromptSetCreatesFourConsistentPrompts();
