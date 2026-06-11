export type ShopeeCategoryOption = {
  value: string;
  label: string;
  aliases: string[];
};

export const DEFAULT_SHOPEE_CATEGORY = "all";

export const SHOPEE_CATEGORY_OPTIONS = [
  { value: "all", label: "All Categories", aliases: ["", "all", "general", "lifestyle, beauty, home"] },
  { value: "home_living", label: "Home & Living", aliases: ["home", "home living", "home & living", "home_living", "living"] },
  { value: "beauty", label: "Beauty & Personal Care", aliases: ["beauty", "beauty personal care", "beauty & personal care", "personal care"] },
  { value: "health", label: "Health", aliases: ["health", "สุขภาพ"] },
  { value: "fashion", label: "Fashion", aliases: ["fashion"] },
  { value: "womens_fashion", label: "Women's Fashion", aliases: ["women", "women fashion", "women's fashion", "womens fashion"] },
  { value: "mens_fashion", label: "Men's Fashion", aliases: ["men", "men fashion", "men's fashion", "mens fashion"] },
  { value: "mobile", label: "Mobile & Gadgets", aliases: ["mobile", "gadgets", "mobile & gadgets", "mobile gadgets"] },
  {
    value: "computers_accessories",
    label: "Computers & Accessories",
    aliases: ["computer", "computers", "accessories", "computers & accessories", "computers accessories"]
  },
  { value: "home_appliances", label: "Home Appliances", aliases: ["home appliances", "appliances"] },
  { value: "food", label: "Food & Beverage", aliases: ["food", "beverage", "food & beverage", "food beverage"] },
  { value: "mom_baby", label: "Mom & Baby", aliases: ["mom", "baby", "mom & baby", "mom baby"] },
  { value: "pets", label: "Pets", aliases: ["pet", "pets"] },
  { value: "sports", label: "Sports & Outdoors", aliases: ["sport", "sports", "outdoors", "sports & outdoors", "sports outdoors"] },
  { value: "automotive", label: "Automotive", aliases: ["auto", "automotive", "car", "cars"] },
  { value: "stationery", label: "Stationery", aliases: ["stationery", "stationary"] },
  { value: "toys_games", label: "Toys & Games", aliases: ["toy", "toys", "games", "toys & games", "toys games"] },
  { value: "travel_luggage", label: "Travel & Luggage", aliases: ["travel", "luggage", "travel & luggage", "travel luggage"] },
  { value: "jewelry_watches", label: "Jewelry & Watches", aliases: ["jewelry", "jewellery", "watches", "jewelry & watches"] },
  { value: "books_hobbies", label: "Books & Hobbies", aliases: ["books", "hobbies", "books & hobbies", "books hobbies"] }
] as const satisfies readonly ShopeeCategoryOption[];

const OPTION_BY_VALUE = new Map<string, ShopeeCategoryOption>(SHOPEE_CATEGORY_OPTIONS.map((option) => [option.value, option]));
const OPTION_BY_ALIAS = new Map(
  SHOPEE_CATEGORY_OPTIONS.flatMap((option) => [
    [normalizeCategoryText(option.value), option.value] as const,
    [normalizeCategoryText(option.label), option.value] as const,
    ...option.aliases.map((alias) => [normalizeCategoryText(alias), option.value] as const)
  ])
);

function normalizeCategoryText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeShopeeCategory(value?: string | null) {
  const normalized = normalizeCategoryText(String(value ?? ""));
  if (!normalized) return DEFAULT_SHOPEE_CATEGORY;
  return OPTION_BY_ALIAS.get(normalized) ?? (OPTION_BY_VALUE.has(value ?? "") ? String(value) : DEFAULT_SHOPEE_CATEGORY);
}

export function normalizeShopeeCategories(values?: Array<string | null | undefined> | string | null) {
  const rawValues = Array.isArray(values) ? values : [values];
  const normalized = rawValues
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => normalizeShopeeCategory(value))
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  if (!unique.length) return [];
  // If only "all" is present (or all values resolved to "all"), treat as no specific category.
  // But if the user also picked specific categories alongside "all", keep those specific ones.
  const withoutAll = unique.filter((c) => c !== DEFAULT_SHOPEE_CATEGORY);
  if (withoutAll.length) return withoutAll;
  if (unique.includes(DEFAULT_SHOPEE_CATEGORY)) return [];
  return unique;
}

export function isValidShopeeCategory(value?: string | null) {
  return OPTION_BY_VALUE.has(normalizeShopeeCategory(value));
}

export function isValidShopeeCategories(values?: Array<string | null | undefined> | string | null) {
  return normalizeShopeeCategories(values).every((value) => OPTION_BY_VALUE.has(value));
}

export function getShopeeCategoryOption(value?: string | null) {
  return OPTION_BY_VALUE.get(normalizeShopeeCategory(value)) ?? OPTION_BY_VALUE.get(DEFAULT_SHOPEE_CATEGORY)!;
}

export function getShopeeCategoryLabel(value?: string | null) {
  return getShopeeCategoryOption(value).label;
}

export function getShopeeCategorySearchTerms(value?: string | null) {
  const option = getShopeeCategoryOption(value);
  if (option.value === DEFAULT_SHOPEE_CATEGORY) return [];
  return Array.from(new Set([option.label, option.value, ...option.aliases].filter(Boolean)));
}

export function isShopeeCategoryMatch(productCategory?: string | null, categoryValue?: string | null) {
  const terms = getShopeeCategorySearchTerms(categoryValue).map(normalizeCategoryText).filter(Boolean);
  if (!terms.length) return true;
  const productText = normalizeCategoryText(String(productCategory ?? ""));
  return terms.some((term) => productText === term || productText.includes(term) || term.includes(productText));
}
