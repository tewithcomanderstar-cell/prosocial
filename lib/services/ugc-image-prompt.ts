import type {
  ShopeeCaptionStyle,
  ShopeeImagePromptConcept,
  ShopeeImagePromptSet,
  ShopeeProductRecord,
  ShopeeProductVisualAnalysis
} from "@/lib/services/shopee-affiliate-core";

const UGC_BASE_PROMPT = [
  "Create realistic UGC-style product review photos using the original Shopee product image as the exact visual reference.",
  "The final image must look like a real customer review photo taken with a smartphone camera, not a marketing banner or template.",
  "Use the original product as the source of truth: do not change product shape, color, logo, material, model, or visible details.",
  "Do not invent a new product or create a fake version of the product.",
  "The image must feel like organic TikTok Shop, Shopee Affiliate, and Facebook review content.",
  "Product fills 70-85% of the 1080x1080 frame, with natural shadows, real-life environment, natural lighting, and slight handheld feel.",
  "Do not generate Thai text or any readable text in the image. Thai copy will be overlaid later by server-side rendering."
].join(" ");

const UGC_NEGATIVE_PROMPT = [
  "no marketing banner",
  "no poster",
  "no flyer",
  "no product catalog card",
  "no template layout",
  "no corporate ad",
  "no 3D render",
  "no CGI",
  "no fake product",
  "no unrealistic product shape",
  "no distorted logo",
  "no unreadable text",
  "no AI-generated Thai text",
  "no empty white template",
  "no excessive graphic elements",
  "no floating product on a blank background",
  "no fake reviews",
  "no fake screenshots",
  "no fake Shopee UI"
].join(", ");

function buildProductReferenceBlock(product: ShopeeProductRecord, analysis: ShopeeProductVisualAnalysis, style: ShopeeCaptionStyle) {
  return [
    `Product name: ${product.productName}.`,
    `Product category: ${product.category || "general lifestyle product"}.`,
    `Product description: ${product.productDescription || product.productName}.`,
    `Product image reference URL: ${product.productImageUrl || "provided as reference image"}.`,
    `Visual identity that must remain unchanged: ${analysis.keyVisualIdentity.join("; ")}.`,
    `Shape/material hints: ${analysis.shape}; ${analysis.materials}.`,
    `Caption style context only: ${style.replace(/_/g, " ")}. Do not add text to the image.`
  ].join(" ");
}

function promptForConcept(input: {
  product: ShopeeProductRecord;
  analysis: ShopeeProductVisualAnalysis;
  style: ShopeeCaptionStyle;
  concept: ShopeeImagePromptConcept["concept"];
  title: string;
  instructions: string[];
}) {
  return {
    concept: input.concept,
    title: input.title,
    prompt: [
      UGC_BASE_PROMPT,
      buildProductReferenceBlock(input.product, input.analysis, input.style),
      ...input.instructions,
      `Negative prompt: ${UGC_NEGATIVE_PROMPT}.`
    ].join(" ")
  };
}

export function buildUgcShopeeImagePromptSet(
  product: ShopeeProductRecord,
  style: ShopeeCaptionStyle,
  analysis: ShopeeProductVisualAnalysis
): ShopeeImagePromptSet {
  const prompts: ShopeeImagePromptConcept[] = [
    promptForConcept({
      product,
      analysis,
      style,
      concept: "hero_product_shot",
      title: "Image 1: Hero review shot",
      instructions: [
        "Image 1 hero review shot: product placed naturally in a real-life environment, large and clear, like a customer photographed it after receiving the item.",
        "Use a close smartphone 3/4 angle, natural daylight or window light, real shadows, casual composition, and no empty whitespace.",
        "The product must dominate the frame and remain the exact same item as the reference."
      ]
    }),
    promptForConcept({
      product,
      analysis,
      style,
      concept: "close_up_detail",
      title: "Image 2: Close-up detail shot",
      instructions: [
        "Image 2 close-up detail shot: show material, texture, feature, opening, button, strap, handle, zipper, display, or important detail depending on product type.",
        "Realistic hand interaction is allowed if suitable, but hands must not distort or cover the product identity.",
        "Product fills most of the frame with a natural review-photo crop."
      ]
    }),
    promptForConcept({
      product,
      analysis,
      style,
      concept: "lifestyle_usage",
      title: "Image 3: Usage context shot",
      instructions: [
        "Image 3 usage context shot: show the product being used in a realistic situation with lifestyle background.",
        "Make it feel casual, organic, and useful, like a real customer review photo from a phone.",
        "Do not over-stage the scene; preserve accurate product details and keep the product prominent."
      ]
    }),
    promptForConcept({
      product,
      analysis,
      style,
      concept: "viral_review_style",
      title: "Image 4: Social review CTA shot",
      instructions: [
        "Image 4 social review CTA shot: product shown clearly in a real environment, suitable for Facebook feed and Shopee Affiliate post.",
        "Use an engaging but believable social-commerce composition, with product foregrounded and clear.",
        "Leave a small safe area for later Thai text overlay, but do not generate any text."
      ]
    })
  ];

  return {
    productVisualAnalysis: analysis,
    consistencyInstructions: [
      "Use the real Shopee product image as the source of truth.",
      "Preserve product shape, color, logo, model, material, proportions, and visible details across all 4 images.",
      "Generate 4 different angles/compositions of the same product: hero, detail, usage, and social review CTA.",
      "Product must fill 70-85% of the frame and look like a real smartphone review photo.",
      "AI image generation must not create Thai text; Thai text is rendered later with server-side SVG/Sharp."
    ],
    prompts,
    negativePrompt: UGC_NEGATIVE_PROMPT
  };
}

