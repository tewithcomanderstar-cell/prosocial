# Shopee Product Filtering Audit

Last updated: 2026-06-12

This document describes the simplified Shopee product selection flow used by Auto Post after removing source-specific scoring, manual keyword search, min rating, min sales, and min discount filters.

## Current Model

Auto Post now treats Shopee discovery as:

```text
Selected categories
-> fetch broad product pool
-> normalize and dedupe
-> hard product validity filters
-> price filter
-> Sold Count Filter
-> 48h duplicate and reservation filters
-> random pick from remaining products
-> Product Intelligence / caption / image package
```

There is no user-facing source selector, no user keyword search, and no source-specific product score in the final selection path.

## Entry Points

UI:

- `components/auto-post-panel.tsx`
- Category field: `shopeeCategories` / `shopeeCategory`
- Sold threshold field: `shopeeMinSoldCount`
- Price fields: `shopeeMinPrice`, `shopeeMaxPrice`

API:

- `app/api/auto-post/route.ts` saves config and unsets legacy source/keyword/rating/sales/discount fields.
- `app/api/auto-post/start/route.ts` starts a manual run.
- `app/api/auto-post/process-step/route.ts` runs the worker step.
- `app/api/shopee/products/route.ts` previews/discovers Shopee products from selected categories.

Services:

- `lib/services/auto-post.ts`
- `lib/services/shopee-affiliate.ts`
- `lib/services/queue.ts` records posted product history after successful publish.

Shopee provider:

- `getShopeeProductProvider()`
- `ShopeeOfficialApiProvider.fetchProducts()`
- `fetchShopeeAffiliateGraphqlProducts()`
- `MockShopeeProvider.fetchProducts()` when mock mode is active.

## Discovery Flow

All Auto Post selection calls:

```ts
selectShopeeProductsForPages()
```

That function always discovers products through:

```ts
fetchShopeeAllProductsForSelectedCategories()
```

The selected categories are normalized with:

```ts
normalizeShopeeCategories()
```

Multi-category behavior is OR logic:

```text
category A products
+ category B products
+ category C products
-> merge
-> dedupe
```

The system does not require one product to match every selected category.

## Shopee API Behavior

`fetchShopeeAllProductsForSelectedCategories()`:

- Loads selected categories.
- Shuffles category order.
- Fetches each selected category.
- Uses randomized page/offset where supported.
- Uses randomized sort modes where supported.
- Fetches a broader pool than needed.
- Normalizes all provider responses.
- Deduplicates before filtering.

For each category, provider fetch still may pass a category-derived Thai discovery term internally. This is only for product discovery and is not a user keyword filter or caption input.

## Deduplication

Dedupe key priority:

1. `shopId:itemId`
2. `productId`
3. product URL canonical item id
4. normalized product name + shop name hash fallback

Implemented around:

- `getShopeeCanonicalProductKey()`
- `dedupeShopeeProducts()`

## Filter Order

Implemented mainly in `getShopeeProductFilterRejectionReason()` and `selectShopeeProductsForPages()`.

Current strict filter order:

1. Already selected in the same request
2. Explicitly excluded product ID
3. Has image
4. Has product URL or affiliate URL
5. Not out of stock
6. Product name is not English-only
7. Not blocked category
8. Min Price
9. Max Price
10. Sold Count Filter
11. Duplicate 48h cooldown
12. Active reservation
13. Already posted today
14. Page-level recently posted check
15. Random selection from remaining products
16. Product Intelligence confidence, after selection during package/caption generation

Removed selection controls:

- Source selector
- User keyword search
- Rating threshold
- Sales threshold
- Discount threshold
- Source score threshold
- Ranked scoring

## Rejection Reasons

Public diagnostics use these names:

| Reason | Meaning | Strict or Relaxable |
|---|---|---|
| `missing_image` | Product has no usable image URL | Strict |
| `missing_product_url` | Product has no product URL or affiliate URL | Strict |
| `out_of_stock` | Stock exists and is `<= 0` | Strict |
| `blocked_category` | Product category matches blocked category config | Strict |
| `below_min_price` | Product price is lower than configured min | Configurable |
| `above_max_price` | Product price is higher than configured max | Configurable |
| `below_min_sold_count` | Sold count is below selected Sold Count Filter | Configurable |
| `duplicate_48h` | Product was posted within cooldown window | Strict |
| `reserved_by_active_job` | Product is reserved by another active job | Strict |
| `product_understanding_low_confidence` | Product Intelligence confidence is below 70 after selection | Strict for content generation |

Internal aliases:

- `duplicate_product_48h` -> `duplicate_48h`
- `reserved_product` -> `reserved_by_active_job`

## Sold Count Filter

Sold Count Filter is separate from product discovery. It is not a Shopee source.

Supported thresholds:

- No sold filter
- Sold Count Filter 500+
- Sold Count Filter 1000+
- Sold Count Filter 1500+
- Sold Count Filter 2000+

Filtering rule:

```text
product.soldCount < selected threshold
-> reject below_min_sold_count
```

Related logs:

- `SOLD_COUNT_FILTER_APPLIED`
- `PRODUCT_REJECTED_BELOW_MIN_SOLD`
- `PRODUCT_ACCEPTED_SOLD_THRESHOLD`

## Selection

After filters pass, selection is intentionally unscored:

```text
eligible products
-> buildUnscoredShopeeSelectionCandidate()
-> pickRandomFilteredShopeeCandidate()
```

The selected candidate records the reason:

```text
selected_by_filters_only
```

This prevents stale score logic from eliminating valid Shopee products.

## Duplicate And Reservation Guard

48-hour duplicate prevention applies after the sold count and price filters.

Flow:

1. Fetch products.
2. Remove invalid products.
3. Apply price and Sold Count Filter.
4. Exclude products posted within the cooldown window.
5. Exclude products reserved by active jobs.
6. Reserve the selected product.
7. Save posted history only after successful Facebook publish.

Related logs:

- `RECENT_PRODUCT_EXCLUSION_APPLIED`
- `DUPLICATE_PRODUCT_SKIPPED_48H`
- `PRODUCT_RESERVED`
- `PRODUCT_RESERVATION_RELEASED`
- `POSTED_PRODUCT_HISTORY_SAVED`

## Product Intelligence Filter

Product Intelligence runs after product selection, before caption/image package creation:

```text
selected Shopee product
-> Product Intelligence
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
  "afterSoldCountFilter": 40,
  "afterDuplicate48hFilter": 36,
  "afterReservationFilter": 35,
  "afterProductIntelligence": 1,
  "finalEligibleProducts": 1,
  "rejectionSummary": {},
  "sampleRejectedProducts": []
}
```

Related logs:

- `PRODUCT_REJECTION_SUMMARY`
- `TOP_REJECTED_PRODUCTS`
- `SOURCE_DATA_QUALITY`
- `SOLD_COUNT_FILTER_APPLIED`
- `PRODUCT_SELECTION_ROOT_CAUSE`
- `PRODUCT_SELECTION_EXPANDED`

## Empty Pool Recovery

If strict filtering returns zero selected products:

1. `FALLBACK_PRODUCT_SELECTION_USED`
   - Keeps hard product validity checks.
   - Still protects price, sold threshold, duplicate 48h, and active reservations unless explicitly configured otherwise.

2. `MULTI_CATEGORY_PRODUCT_SELECTION_RESCUE_STARTED`
   - For multi-category runs.
   - Fetches a broad category pool again.

3. `PRODUCT_SELECTION_EXPANDED`
   - Fetches selected categories again with a fresh random page seed.
   - Keeps OR category logic.

The workflow should only report no eligible products after all recovery attempts are exhausted.

## Why No Eligible Products Can Still Happen

Common causes:

- Shopee API returned products without image URLs.
- Shopee API returned products without product or affiliate URLs.
- Products are out of stock.
- The selected categories are too narrow.
- The min/max price range excludes every product.
- Sold Count Filter is higher than available products in the selected categories.
- Every product was posted within the 48-hour cooldown window.
- Every product is reserved by an active job.
- Product Intelligence rejects selected products due to low confidence.

## Recommended Operating Defaults

- Keep Sold Count Filter unset or 500+ for broad categories.
- Use Min Price and Max Price only when needed.
- Select multiple categories when the product pool is too small.
- Avoid very narrow price ranges combined with high sold thresholds.
