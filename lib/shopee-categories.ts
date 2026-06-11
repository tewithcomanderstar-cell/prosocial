export type ShopeeCategoryOption = {
  value: string;
  label: string;
  thaiKeyword: string;
  aliases: string[];
};

export const DEFAULT_SHOPEE_CATEGORY = "all";

export const SHOPEE_CATEGORY_OPTIONS = [
  { value: "all", label: "All Categories", thaiKeyword: "สินค้ายอดนิยม", aliases: ["", "all", "general", "lifestyle, beauty, home"] },
  { value: "home_living", label: "Home & Living", thaiKeyword: "ของใช้ในบ้าน", aliases: ["home", "home living", "home & living", "home_living", "living"] },
  { value: "beauty", label: "Beauty & Personal Care", thaiKeyword: "เครื่องสำอาง บิวตี้", aliases: ["beauty", "beauty personal care", "beauty & personal care", "personal care"] },
  { value: "health", label: "Health", thaiKeyword: "สุขภาพ อาหารเสริม", aliases: ["health", "สุขภาพ"] },
  { value: "fashion", label: "Fashion", thaiKeyword: "เสื้อผ้าแฟชั่น", aliases: ["fashion"] },
  { value: "womens_fashion", label: "Women's Fashion", thaiKeyword: "เสื้อผ้าผู้หญิง", aliases: ["women", "women fashion", "women's fashion", "womens fashion"] },
  { value: "mens_fashion", label: "Men's Fashion", thaiKeyword: "เสื้อผ้าผู้ชาย", aliases: ["men", "men fashion", "men's fashion", "mens fashion"] },
  { value: "mobile", label: "Mobile & Gadgets", thaiKeyword: "มือถือ แกดเจ็ต", aliases: ["mobile", "gadgets", "mobile & gadgets", "mobile gadgets"] },
  {
    value: "computers_accessories",
    label: "Computers & Accessories",
    thaiKeyword: "คอมพิวเตอร์ อุปกรณ์ไอที",
    aliases: ["computer", "computers", "accessories", "computers & accessories", "computers accessories"]
  },
  { value: "home_appliances", label: "Home Appliances", thaiKeyword: "เครื่องใช้ไฟฟ้า", aliases: ["home appliances", "appliances"] },
  { value: "food", label: "Food & Beverage", thaiKeyword: "อาหาร เครื่องดื่ม", aliases: ["food", "beverage", "food & beverage", "food beverage"] },
  { value: "mom_baby", label: "Mom & Baby", thaiKeyword: "แม่และเด็ก ของใช้เด็ก", aliases: ["mom", "baby", "mom & baby", "mom baby"] },
  { value: "pets", label: "Pets", thaiKeyword: "สัตว์เลี้ยง อุปกรณ์สัตว์เลี้ยง", aliases: ["pet", "pets"] },
  { value: "sports", label: "Sports & Outdoors", thaiKeyword: "กีฬา ออกกำลังกาย", aliases: ["sport", "sports", "outdoors", "sports & outdoors", "sports outdoors"] },
  { value: "automotive", label: "Automotive", thaiKeyword: "อุปกรณ์รถยนต์", aliases: ["auto", "automotive", "car", "cars"] },
  { value: "stationery", label: "Stationery", thaiKeyword: "เครื่องเขียน อุปกรณ์สำนักงาน", aliases: ["stationery", "stationary"] },
  { value: "toys_games", label: "Toys & Games", thaiKeyword: "ของเล่น เกม", aliases: ["toy", "toys", "games", "toys & games", "toys games"] },
  { value: "travel_luggage", label: "Travel & Luggage", thaiKeyword: "กระเป๋าเดินทาง ท่องเที่ยว", aliases: ["travel", "luggage", "travel & luggage", "travel luggage"] },
  { value: "jewelry_watches", label: "Jewelry & Watches", thaiKeyword: "เครื่องประดับ นาฬิกา", aliases: ["jewelry", "jewellery", "watches", "jewelry & watches"] },
  { value: "books_hobbies", label: "Books & Hobbies", thaiKeyword: "หนังสือ งานอดิเรก", aliases: ["books", "hobbies", "books & hobbies", "books hobbies"] }
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

export function getShopeeCategoryThaiKeyword(value?: string | null) {
  return getShopeeCategoryOption(value).thaiKeyword || "";
}

export function getShopeeCategorySearchTerms(value?: string | null) {
  const option = getShopeeCategoryOption(value);
  if (option.value === DEFAULT_SHOPEE_CATEGORY) return [];
  // Prefer Thai keyword first so Shopee TH API returns Thai-language products.
  return Array.from(new Set([option.thaiKeyword, option.label, option.value, ...option.aliases].filter(Boolean)));
}

export function isShopeeCategoryMatch(productCategory?: string | null, categoryValue?: string | null) {
  const terms = getShopeeCategorySearchTerms(categoryValue).map(normalizeCategoryText).filter(Boolean);
  if (!terms.length) return true;
  const productText = normalizeCategoryText(String(productCategory ?? ""));
  return terms.some((term) => productText === term || productText.includes(term) || term.includes(productText));
}
