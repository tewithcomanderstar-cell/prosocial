# Shopee Product Filtering Audit

Last updated: 2026-06-12

This document traces the current Shopee product selection flow from product fetch to the final selected product used by Auto Post.

## Entry Points

UI:
- `components/auto-post-panel.tsx`
- Source field: `shopeeSourceTag`
- Sold threshold field: `shopeeMinSoldCount`
- Category field: `shopeeCategories` / `shopeeCategory`

API:
- `app/api/auto-post/route.ts` saves config and normalizes legacy sold sources.
- `app/api/auto-post/start/route.ts` starts a manual run and validates required source inputs.
- `app/api/auto-post/process-step/route.ts` runs the worker step.
- `app/api/shopee/products/route.ts` previews/discovers Shopee products.

Service:
- `lib/services/auto-post.ts`
- `lib/services/shopee-affiliate.ts`

Shopee provider:
- `getShopeeProductProvider()`
- `ShopeeOfficialApiProvider.fetchProducts()`
- `fetchShopeeAffiliateGraphqlProducts()`
- `MockShopeeProvider.fetchProducts()` when mock mode is active.

## Source Flow

All real Auto Post source selection eventually calls:

```ts
selectShopeeProductsForPages()
```

### Source Matrix

| Source | Function Called | Shopee API Query | Categories Applied | Multi Category Logic | Initial Fetch Size |
|---|---|---|---|---|---|
| Trending | `provider.fetchProducts({ sourceTag: "trending" })` | GraphQL `productOfferV2(limit, page, listType: 0, keyword)` or REST query params | Yes | OR, fetch each selected category then merge | 30-50 per category |
| Best Selling | `provider.fetchProducts({ sourceTag: "best_selling" })` | GraphQL `productOfferV2`, `listType: 1` only when allowed by matchId | Yes | OR, fetch each selected category then merge | 30-50 per category |
| Top Searched | `provider.fetchProducts({ sourceTag: "top_search" })` | GraphQL `productOfferV2`, `listType: 2` only when allowed by matchId | Yes | OR, fetch each selected category then merge | 30-50 per category |
| Best ROI | `provider.fetchProducts({ sourceTag: "best_roi" })` | GraphQL `productOfferV2`, `listType: 3` only when allowed by matchId | Yes | OR, fetch each selected category then merge | 30-50 per category |
| Manual Keyword | `provider.fetchProducts({ sourceTag: "manual", keyword })` | GraphQL `productOfferV2(limit, page, listType: 0, keyword)` | Yes | OR, fetch each selected category then merge | 30-50 per category |
| All Products | `fetchShopeeAllProductsForSelectedCategories()` | Calls provider once per selected category with randomized page and category Thai keyword | Required | OR, fetch every selected category, merge and dedupe | `limit * 3`, minimum 30 per category |
| SOLD 500+ | Same selected source + `minSoldCount = 500` | Not a separate Shopee source | Yes | Same as selected source | Same as selected source |
| SOLD 1000+ | Same selected source + `minSoldCount = 1000` | Not a separate Shopee source | Yes | Same as selected source | Same as selected source |
| SOLD 1500+ | Same selected source + `minSoldCount = 1500` | Not a separate Shopee source | Yes | Same as selected source | Same as selected source |
| SOLD 2000+ | Same selected source + `minSoldCount = 2000` | Not a separate Shopee source | Yes | Same as selected source | Same as selected source |

Important: SOLD 500/1000/1500/2000 are filters, not source tags. Legacy configs that stored sold thresholds as source tags are normalized to `best_selling + shopeeMinSoldCount`.

## Shopee API Details

When `SHOPEE_AUTH_MODE=affiliate_graphql`, the query is:

```graphql
query {
  productOfferV2(limit: N, page: P, listType: X, keyword: "...") {
    nodes {
      productName
      itemId
      shopId
      productLink
      offerLink
      imageUrl
      price
      priceMin
      priceMax
      sales
      ratingStar
      commissionRate
      shopName
    }
  }
}
```

`listType` behavior:
- `trending`, `manual`, `all_products`: `0`
- `best_selling`: `1`
- `top_search`: `2`
- `best_roi`: `3`

If `listType` needs `matchId` and no `SHOPEE_AFFILIATE_MATCH_ID` exists, the system skips invalid listType usage and logs `listType_requires_matchId_but_matchId_missing`.

If GraphQL returns an empty listType result, the provider retries a minimal `productOfferV2(limit, page)` query.

## Category Logic

Selected categories are normalized with:

```ts
normalizeShopeeCategories()
```

For normal sources, the service loops over every selected category:

```ts
for (const category of discoveryCategories) {
  provider.fetchProducts({ sourceTag, keyword, category, limit })
}
```

The result is OR logic:

```text
category A products
+ category B products
+ category C products
-> merge
-> dedupe
```

The system does not require one product to match every selected category.

For `all_products`, `fetchShopeeAllProductsForSelectedCategories()` shuffles selected categories, fetches each one with a random page, merges all results, and dedupes.

Dedupe key order:
1. `shopId:itemId`
2. `productId`
3. product URL item id
4. hash of normalized product name + shop name

## Filter Order

Implemented mainly in `getShopeeProductFilterRejectionReason()` and `selectShopeeProductsForPages()`.

Exact strict filter order:

1. Already selected in the same request
2. Explicitly excluded product ID
3. Has image
4. Has product URL or affiliate URL
5. Not out of stock
6. Product name is not English-only
7. Not blocked category
8. Min price
9. Max price
10. Min rating
11. Min sales
12. Sold count filter
13. Min discount
14. Duplicate 48h cooldown
15. Active reservation
16. Already posted today
17. Page-level recently posted check
18. Source score filter
19. Ranked top-candidate random selection
20. Product Intelligence confidence, after selection during package/caption generation

## Rejection Reasons

Public diagnostics use these names:

| Reason | Meaning | Strict or Relaxable |
|---|---|---|
| `missing_image` | Product has no usable image URL | Strict |
| `missing_product_url` | Product has no product URL or affiliate URL | Strict |
| `out_of_stock` | Stock exists and is `<= 0` | Strict |
| `blocked_category` | Product category matches blocked category config | Strict |
| `below_min_price` | Product price is lower than configured min | Relaxable |
| `above_max_price` | Product price is higher than configured max | Relaxable |
| `below_min_rating` | Product rating is below configured min | Relaxable |
| `below_min_sales` | Product sales count is below configured min | Relaxable |
| `below_min_discount` | Discount percent is below configured min | Relaxable |
| `below_min_sold_count` | Sold count is below selected SOLD threshold | Relaxable only when `SHOPEE_ALLOW_RELAX_SOLD_THRESHOLD_ON_EMPTY=true` |
| `duplicate_48h` | Product was posted within cooldown window | Strict |
| `reserved_by_active_job` | Product is reserved by another active job | Strict |
| `below_source_score` | Source-specific score is below threshold | Relaxable by fallback/expanded selection |
| `product_understanding_low_confidence` | Product Intelligence confidence is below 70 after selection | Strict for content generation |

Internal legacy aliases still exist in code for backward compatibility:
- `duplicate_product_48h` -> `duplicate_48h`
- `reserved_product` -> `reserved_by_active_job`
- `below_min_source_score` -> `below_source_score`

## Source Scoring

Implemented in `scoreShopeeProductForSource()`.

Trending:

```text
salesMomentumScore * 0.35
+ discountScore * 0.20
+ ratingScore * 0.15
+ reviewScore * 0.10
+ freshnessScore * 0.10
+ sourceApiBonus * 0.10
```

Best Selling:

```text
salesScore * 0.60
+ reviewScore * 0.20
+ ratingScore * 0.15
+ productQualityScore * 0.05
```

Top Searched:

If `searchVolume` exists, it is used. Otherwise the fallback is:

```text
keywordMatchScore * 0.35
+ salesScore * 0.25
+ reviewScore * 0.15
+ ratingScore * 0.10
+ sourceApiBonus * 0.15
```

Best ROI:

```text
estimatedCommissionScore * 0.45
+ conversionProxy * 0.45
+ productQualityScore * 0.10
```

Manual Keyword:

```text
exactKeywordMatch * 0.40
+ partialKeywordMatch * 0.20
+ categoryMatch * 0.10
+ salesScore * 0.15
+ ratingScore * 0.10
+ commissionScore * 0.05
```

All Products:

```text
productQualityScore * 0.35
+ ratingScore * 0.20
+ salesScore * 0.20
+ discountScore * 0.15
+ reviewScore * 0.10
```

Source score thresholds:
- Normal sources: `SHOPEE_MIN_SOURCE_SPECIFIC_SCORE = 20`
- `all_products`: `SHOPEE_MIN_ALL_PRODUCTS_SCORE = 10`

Final source selection:
1. Calculate source-specific score.
2. Sort candidates descending.
3. Keep top 5 or top 10 depending on source.
4. Randomly pick only inside top candidates.

## Product Intelligence Filter

Product Intelligence runs after product selection, before caption/image package creation:

```text
selected Shopee product
-> generateShopeeCaption()
-> extract text understanding
-> optional vision rescue
-> analyzeThaiBuyerProductIntelligence()
-> confidenceScore >= 0.70 required
```

If confidence is too low, the product is skipped with:

```text
product_understanding_low_confidence
```

This is intentionally after selection because it may need AI/vision and should not run on every fetched product.

## PRODUCT_SELECTION_FUNNEL Log

The selection service logs:

```json
{
  "source": "all_products",
  "selectedCategories": ["home_living", "fashion"],
  "fetchedProducts": 120,
  "afterNormalize": 90,
  "afterImageFilter": 88,
  "afterUrlFilter": 86,
  "afterStockFilter": 86,
  "afterBlockedCategory": 84,
  "afterPriceFilter": 82,
  "afterRatingFilter": 82,
  "afterSalesFilter": 82,
  "afterDiscountFilter": 82,
  "afterSoldCountFilter": 40,
  "afterDuplicate48hFilter": 36,
  "afterReservationFilter": 35,
  "afterSourceScoreFilter": 22,
  "afterProductIntelligence": 1,
  "finalEligibleProducts": 1,
  "rejectionSummary": {},
  "sampleRejectedProducts": []
}
```

Related logs:
- `PRODUCT_REJECTION_SUMMARY`
- `TOP_REJECTED_PRODUCTS`
- `SOURCE_SCORE_BREAKDOWN`
- `SOURCE_DATA_QUALITY`
- `SOLD_COUNT_FILTER_APPLIED`
- `PRODUCT_SELECTION_ROOT_CAUSE`
- `PRODUCT_SELECTION_EXPANDED`

## Empty Pool Recovery

If strict filtering returns zero selected products:

1. `FALLBACK_PRODUCT_SELECTION_USED`
   - Keeps only hard requirements.
   - Still protects sold threshold, duplicate 48h, and active reservations.

2. `MULTI_CATEGORY_PRODUCT_SELECTION_RESCUE_STARTED`
   - For multi-category runs.
   - Fetches broad `all_products` pool from all selected categories.

3. `PRODUCT_SELECTION_EXPANDED`
   - Runs before final failure.
   - Fetches all selected categories again with a fresh random page seed.
   - Keeps OR category logic.
   - Keeps duplicate and reservation protection.
   - Lowers sold threshold only when `SHOPEE_ALLOW_RELAX_SOLD_THRESHOLD_ON_EMPTY=true`.

Only after all recovery attempts are exhausted does the service throw:

```text
shopee_no_eligible_products
```

## Why "No Eligible Shopee Products" Can Happen

Common causes:

1. Selected categories return too few products from Shopee.
2. Products do not have image/product URL fields.
3. Products are blocked by sold threshold.
4. Products are blocked by price/rating/sales/discount filters.
5. Products were posted within the 24h/48h cooldown window.
6. Products are reserved by another active job.
7. Source score threshold is too high for sparse Shopee API fields.
8. Product Intelligence confidence fails after selection.

## Recommendations

To keep workflow running continuously:

1. Prefer `all_products` when selected categories are broad.
2. Keep SOLD threshold separate from source selection.
3. Keep min rating/sales/discount defaults low unless the user explicitly configures them.
4. Use `PRODUCT_SELECTION_FUNNEL` and `PRODUCT_SELECTION_ROOT_CAUSE` to tune filters from real evidence.
5. Enable `SHOPEE_ALLOW_RELAX_SOLD_THRESHOLD_ON_EMPTY=true` only if continuous posting matters more than strict sold thresholds.
6. Keep duplicate and reservation filters strict to avoid repeated posts.
7. Do not move Product Intelligence before product pool filtering unless cost is acceptable.
