import type {
  ShopeeCaptionStyle,
  ShopeeImagePromptConcept,
  ShopeeImagePromptSet,
  ShopeeProductRecord,
  ShopeeProductVisualAnalysis
} from "@/lib/services/shopee-affiliate-core";

const UGC_BASE_PROMPT = [
  "Create realistic UGC-style product review photos using the original Shopee product image as the exact visual reference.",
  "The final image must look like a real customer review photo taken with a smartphone camera, not a marketing banner, poster, template, catalog card, or ad layout.",
  "Use the original product as the source of truth: do not change product shape, color, logo, material, model, or visible details.",
  "Do not invent a new product or create a fake version of the product.",
  "The image must feel like organic TikTok Shop, Shopee Affiliate, and Facebook review content.",
  "Product fills 70-85% of the 1080x1080 frame, with natural shadows, real-life environment, natural lighting, and slight handheld feel.",
  "Generate the requested Thai text directly inside the image in one step. Do not rely on any later overlay, badge, panel, dark bar, navy rectangle, or text box.",
  "Thai text must be naturally placed in the photo, clean, modern, easy to read, and no more than 2 short lines."
].join(" ");

const UGC_NEGATIVE_PROMPT = [
  "no marketing banner",
  "no poster",
  "no flyer",
  "no product catalog card",
  "no template layout",
  "no corporate ad",
  "no text box",
  "no background panel",
  "no overlay",
  "no badge",
  "no dark bar",
  "no navy rectangle",
  "no 3D render",
  "no CGI",
  "no fake product",
  "no unrealistic product shape",
  "no distorted logo",
  "no unreadable text",
  "no alien text",
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
    `Caption style context only: ${style.replace(/_/g, " ")}.`
  ].join(" ");
}

function buildThaiTextForConcept(product: ShopeeProductRecord, concept: ShopeeImagePromptConcept["concept"]) {
  const text = `${product.productName} ${product.productDescription} ${product.category}`.toLowerCase();
  const isBag = /bag|wallet|pouch|crossbody|กระเป๋า|คาดอก/.test(text);
  const isEarbud = /earbud|earphone|headphone|หูฟัง/.test(text);
  const isShoe = /shoe|sneaker|slipper|crocs|รองเท้า/.test(text);
  const isPower = /power|battery|charger|ชาร์จ|แบต/.test(text);
  const isCar = /tire|tyre|ยาง|รถ/.test(text);

  const categoryLines = isBag
    ? {
        hero: ["ดีไซน์เรียบ", "ใส่ของได้เยอะ"],
        detail: ["ช่องจัดเก็บหลายช่อง", "หยิบของสะดวก"],
        back: ["สายปรับได้ ใส่สบาย", "น้ำหนักเบา ไม่อึดอัด"],
        usage: ["คาดอกหรือคาดเอวได้", "ใช้งานได้ทุกวัน"]
      }
    : isEarbud
      ? {
          hero: ["เสียงชัด ใช้งานง่าย", "พกพาสะดวก"],
          detail: ["ดีเทลชัด จับถนัด", "ใส่สบายไม่เกะกะ"],
          back: ["ขนาดกะทัดรัด", "หยิบใช้ได้ทุกวัน"],
          usage: ["เหมาะกับฟังเพลง", "พกไปไหนก็ง่าย"]
        }
      : isShoe
        ? {
            hero: ["ใส่สบาย แมตช์ง่าย", "ใช้ได้ทุกวัน"],
            detail: ["พื้นนุ่ม เดินสบาย", "ดีเทลดูดี"],
            back: ["ทรงสวย ใส่ง่าย", "ไม่ดูเยอะเกินไป"],
            usage: ["เหมาะกับลุคสบาย ๆ", "เดินเที่ยวก็เอาอยู่"]
          }
        : isPower
          ? {
              hero: ["ชาร์จได้หลายอุปกรณ์", "เหมาะกับสายเดินทาง"],
              detail: ["พอร์ตครบ ใช้ง่าย", "ดูแข็งแรงน่าใช้"],
              back: ["พกไปแคมป์ได้", "ใช้งานนอกบ้านสะดวก"],
              usage: ["มีติดไว้สบายใจ", "กดดูรายละเอียดได้เลย"]
            }
          : isCar
            ? {
                hero: ["ขับนุ่ม เกาะถนนดี", "เหมาะกับใช้งานทุกวัน"],
                detail: ["ดอกยางชัด", "ดูรายละเอียดก่อนเปลี่ยน"],
                back: ["เหมาะกับรถหลายรุ่น", "เช็กรุ่นให้ตรงก่อนซื้อ"],
                usage: ["ใครกำลังเปลี่ยนยาง", "กดดูรายละเอียดได้เลย"]
              }
            : {
                hero: ["ใช้งานง่าย น่าใช้", "เหมาะกับใช้ทุกวัน"],
                detail: ["ดีเทลชัด ดูดี", "หยิบใช้สะดวก"],
                back: ["ขนาดกำลังดี", "พกพาง่าย ไม่เกะกะ"],
                usage: ["ใครมองหาแนวนี้", "กดดูรายละเอียดได้เลย"]
              };

  if (concept === "hero_product_shot") return categoryLines.hero;
  if (concept === "close_up_detail") return categoryLines.detail;
  if (concept === "lifestyle_usage") return categoryLines.back;
  return categoryLines.usage;
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
      `Thai text to place naturally in the photo, exactly 1-2 short lines and Thai only: "${buildThaiTextForConcept(input.product, input.concept).join(" / ")}".`,
      "The Thai text must be part of the generated photo composition itself, with no box, no panel, no badge, no background bar, and no later overlay.",
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
        "The product must dominate the frame and remain the exact same item as the reference.",
        "Place the Thai text like subtle creator text in the photo, not inside a graphic container."
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
        "Product fills most of the frame with a natural review-photo crop.",
        "Place the Thai text close to an empty natural area of the photo, no text box or panel."
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
        "Do not over-stage the scene; preserve accurate product details and keep the product prominent.",
        "Thai text must be short, readable, and naturally integrated into the scene."
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
        "Place the short Thai CTA directly in the photo without any banner, badge, or bottom panel."
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
      "Thai text must be created in the OpenAI image generation step itself; the system must not add any later text overlay."
    ],
    prompts,
    negativePrompt: UGC_NEGATIVE_PROMPT
  };
}
