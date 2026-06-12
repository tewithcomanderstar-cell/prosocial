import OpenAI, { toFile } from "openai";
import { getFallbackVariants } from "@/lib/services/fallback-content";
import { traceExternalRequest } from "@/lib/services/request-debug";
import { GeneratedVariant } from "@/lib/types";

type PersonaContext = {
  tone?: string;
  contentStyle?: string;
  audience?: string;
  promptNotes?: string;
  pageName?: string;
};

type GenerateFacebookContentOptions = {
  persona?: PersonaContext;
  userId?: string;
  customPrompt?: string;
  sourceText?: string;
  sourceLabel?: string;
};

type OptimizationInput = {
  caption: string;
  performanceNotes: string;
  goal?: string;
};

type MultiImagePersonalityReply = {
  optionKey: string;
  replyText: string;
};

export type ShopeeVisionUnderstandingResult = {
  visionProductEntity: string;
  visionProductType: string;
  visionMainUseCase: string;
  visionTargetAudience: string;
  visionConfidence: number;
  visualEvidence: string[];
};

export type ThaiBuyerProductIntelligenceResult = {
  productNameThai: string;
  productType: string;
  mainPurpose: string;
  targetCustomer: string;
  usageScenarios: string[];
  keyBenefits: string[];
  productFacts: string[];
  imageProductSummary: string;
  painPoint: {
    primary: string;
    secondary: string;
  };
  triggerMoment: {
    time: string;
    emotion: string;
    season: string | null;
  };
  humanVoice: {
    howFriendDescribes: string;
    beforeAfter: string;
    oneLinerHook: string;
  };
  contentTone: "friend" | "reviewer" | "homemaker" | "expert" | "storyteller";
  confidenceScore: number;
  lowConfidenceReason?: string;
};

export type ThaiSocialCaptionStyle = "story" | "question" | "before_after" | "friend_tip" | "shock_hook" | "list_benefit";

export type ThaiSocialCaptionResult = {
  captionText: string;
  style: ThaiSocialCaptionStyle;
  tone: string;
  openingType: "emotion" | "question" | "fact" | "scene" | "hook";
  wordCount: number;
  emojiCount: number;
  genericWordsFound: string[];
  qualityScore: number;
  productId: string;
};

export type ThaiLifestyleImagePromptResult = {
  imagePrompt: {
    scene: string;
    subject: string;
    productPlacement: string;
    mood: string;
    lighting: string;
    colorPalette: string;
    humanPresence: string;
    avoidElements: string[];
    styleReference: string;
    fullPrompt: string;
  };
  productId: string;
  matchesCaptionMood: boolean;
  confidenceScore: number;
};


const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export function getContentModel() {
  return process.env.OPENAI_MODEL || process.env.OPENAI_CONTENT_MODEL || "gpt-5-mini";
}

export function getAnalyticsModel() {
  return process.env.OPENAI_ANALYTICS_MODEL || "gpt-5.2";
}

export function getLightweightModel() {
  return process.env.OPENAI_LIGHT_MODEL || "gpt-5-nano";
}

export function getVisionModel() {
  return process.env.OPENAI_VISION_MODEL || process.env.OPENAI_CONTENT_MODEL || "gpt-5-mini";
}

export function getImageModel() {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1";
}

function isSupportedImageEditModel(model: string) {
  return model === "gpt-image-1.5" || model === "gpt-image-1" || model === "gpt-image-1-mini";
}

function resolveImageEditModelForApi(requestedModel: string) {
  const model = requestedModel.trim();
  if (model === "gpt-image-2") {
    return {
      model: "gpt-image-1.5",
      aliasNotice:
        "OPENAI_IMAGE_MODEL=gpt-image-2 is not a direct Image API model in current OpenAI docs; using gpt-image-1.5 for Shopee UGC image edits."
    };
  }
  return { model };
}

function getSafeOpenAiErrorDetails(error: unknown) {
  const record = typeof error === "object" && error ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : "unknown_error";
  const status = typeof record.status === "number" || typeof record.status === "string" ? String(record.status) : "unknown";
  const code = typeof record.code === "string" ? record.code : "unknown";
  const type = typeof record.type === "string" ? record.type : "unknown";
  return { message, status, code, type };
}

function getReferenceImageFileName(mimeType: string, index = 0) {
  const suffix = index > 0 ? `-${index + 1}` : "";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return `shopee-product-reference${suffix}.jpg`;
  if (mimeType.includes("webp")) return `shopee-product-reference${suffix}.webp`;
  return `shopee-product-reference${suffix}.png`;
}

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function generateProductReferenceImage(input: {
  imageBytes: ArrayBuffer;
  mimeType: string;
  prompt: string;
  userId?: string;
  timeoutMs?: number;
  referenceImages?: Array<{
    imageBytes: ArrayBuffer;
    mimeType: string;
  }>;
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OpenAI image edit is not configured: missing OPENAI_API_KEY");
  }
  if (process.env.SHOPEE_AI_IMAGE_EDIT_ENABLED === "false") {
    throw new Error("OpenAI image edit is disabled: SHOPEE_AI_IMAGE_EDIT_ENABLED=false");
  }
  const requestedImageModel = getImageModel();
  const { model: imageModel, aliasNotice } = resolveImageEditModelForApi(requestedImageModel);
  if (aliasNotice) {
    console.info("[ai/image] normalized image edit model", {
      requestedModel: requestedImageModel,
      apiModel: imageModel,
      reason: aliasNotice
    });
  }
  if (!isSupportedImageEditModel(imageModel)) {
    throw new Error(
      `OpenAI image edit model is invalid for Shopee UGC: set OPENAI_IMAGE_MODEL to gpt-image-1.5, gpt-image-1, or gpt-image-1-mini. If you set gpt-image-2, this app will route it to gpt-image-1.5. current=${requestedImageModel}`
    );
  }

  const safePrompt = [
    input.prompt,
    "Create a realistic 100% UGC / real customer review photo from everyday use, not a studio product image, model catalog photo, isolated product packshot, background-cutout product, card, banner, poster, ecommerce thumbnail, marketplace catalog, or Canva template.",
    "Use the provided image only as the strict product identity reference. Preserve the same product shape, colors, brand/logo placement, label placement, material, model, proportions, packaging layout, accessories, and visible details as much as possible.",
    "Do not invent a new product. Do not redesign, recolor, rebrand, translate, repair labels, rewrite packaging text, add fake logos, add fake reviews, or change the product category.",
    "The final image must show the product naturally in a real-life environment with casual smartphone photography, natural light, real shadows, believable depth, and real usage context.",
    "The product must be large in frame, 70-85% of the image area, but must not be isolated on a plain white background or floating on a blank background.",
    "Do not generate Thai text, English text, captions, headlines, labels, badges, UI elements, price labels, stickers, screenshots, text boxes, panels, overlays, borders, dark bars, navy rectangles, or any added explanatory text.",
    "If you cannot preserve the brand or packaging text accurately, keep the original product area visually close to the reference or softly out of focus rather than hallucinating alien text."
  ].join("\n");

  const timeoutMs = Math.max(30_000, Number(input.timeoutMs ?? process.env.OPENAI_IMAGE_TIMEOUT_MS ?? "180000"));
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`OpenAI image edit aborted after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const referenceInputs = [
      { imageBytes: input.imageBytes, mimeType: input.mimeType },
      ...(input.referenceImages ?? [])
    ].slice(0, 16);
    const productFiles = await Promise.all(referenceInputs.map((reference, index) => toFile(
      Buffer.from(reference.imageBytes),
      getReferenceImageFileName(reference.mimeType, index),
      { type: reference.mimeType || "image/png" }
    )));
    const imageInput = productFiles.length === 1 ? productFiles[0] : productFiles;

    const result = await traceExternalRequest(
      {
        step: "OPENAI_IMAGE_EDIT",
        url: "openai://images.edit",
        fn: "generateProductReferenceImage",
        source: "openai_image_generation",
        userId: input.userId,
        metadata: {
          model: imageModel,
          requestedModel: requestedImageModel,
          referenceImages: productFiles.length,
          timeoutMs
        }
      },
      () => client.images.edit({
        model: imageModel,
        image: imageInput,
        prompt: safePrompt,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        n: 1
      }, {
        signal: controller.signal,
        timeout: timeoutMs,
        maxRetries: 0
      })
    );

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("OpenAI image edit returned an empty image response");
    }
    return Buffer.from(b64, "base64");
  } catch (error) {
    const { message, status, code, type } = getSafeOpenAiErrorDetails(error);
    const aborted = controller.signal.aborted || /abort|timeout|timed out/i.test(message);
    console.warn("[ai/image] product reference image edit failed", {
      message,
      status,
      code,
      type,
      model: imageModel,
      requestedModel: requestedImageModel,
      timeoutMs,
      aborted
    });
    if (aborted) {
      throw new Error(`OpenAI image edit timeout after ${timeoutMs}ms (model=${imageModel}, requestedModel=${requestedImageModel})`);
    }
    throw new Error(`OpenAI image edit failed: ${message} (status=${status}, code=${code}, type=${type}, model=${imageModel}, requestedModel=${requestedImageModel})`);
  } finally {
    clearTimeout(timeout);
  }
}

function buildPersonaPrompt(persona?: PersonaContext) {
  return persona
    ? `Target page persona: ${persona.pageName ?? "Unnamed page"}. Tone: ${persona.tone ?? "professional"}. Content style: ${persona.contentStyle ?? "sales"}. Audience: ${persona.audience ?? "general audience"}. Extra notes: ${persona.promptNotes ?? "none"}.`
    : "No page persona was provided. Use a practical Thai Facebook marketing tone.";
}

function buildGenerationPrompt(keyword: string, options: GenerateFacebookContentOptions) {
  const personaPrompt = buildPersonaPrompt(options.persona);
  const promptInstruction = options.customPrompt?.trim()
    ? `Follow this user instruction as the primary creative direction:\n${options.customPrompt.trim()}`
    : "No custom prompt was provided. Write natural, useful Facebook copy from the available context.";
  const sourceBlock = options.sourceText?.trim()
    ? `Source material (${options.sourceLabel?.trim() || "reference"}):\n${options.sourceText.trim()}`
    : "No extra source material was provided.";

  return `${personaPrompt}

Topic or keyword:
${keyword}

${promptInstruction}

Hard rules:
- Final output must read like a finished Facebook post ready to publish.
- Never mention file names, image IDs, OCR, source material, prompt instructions, or internal analysis.
- Never write like a draft note, checklist, analyst memo, or content plan.
- Do not ask the audience to provide missing details about the images.
- If details are incomplete, write naturally from the strongest visible theme only.
- Keep the caption polished, confident, natural, and audience-facing.

${sourceBlock}`;
}

export async function generateFacebookContent(keyword: string, options: GenerateFacebookContentOptions = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return getFallbackVariants(options.userId ?? null, keyword);
  }

  try {
    const model = getContentModel();
    const result = await traceExternalRequest(
      {
        step: "OPENAI_CAPTION_GENERATION",
        url: "openai://responses.create",
        fn: "generateFacebookContent",
        source: "openai_caption_generation",
        userId: options.userId,
        metadata: { model }
      },
      () => client.responses.create({
        model,
        input: [
          {
            role: "system",
            content:
              "You write Thai Facebook marketing content. Treat the custom prompt like a real ChatGPT instruction from the user and follow it closely. Use the source material when provided, but do not invent facts beyond it. The final caption must always read like a finished public-facing post, never like internal notes. Never mention file names, image IDs, OCR text extraction, source material, or analysis steps. Never output planning language, placeholders, or requests for missing information. Return strict JSON with a variants array of 3 to 5 items. Each item must include caption and hashtags. Keep captions ready to post, natural, audience-aware, and aligned to the requested persona and prompt."
          },
          {
            role: "user",
            content: buildGenerationPrompt(keyword, options)
          }
        ]
      })
    );

    const parsed = JSON.parse(extractJson(result.output_text)) as { variants: GeneratedVariant[] };
    return parsed.variants;
  } catch {
    return getFallbackVariants(options.userId ?? null, keyword);
  }
}

export async function analyzeShopeeProductImageUnderstanding(input: {
  imageUrl: string;
  productTitle?: string;
  productDescription?: string;
  timeoutMs?: number;
}): Promise<ShopeeVisionUnderstandingResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OpenAI vision rescue is not configured: missing OPENAI_API_KEY");
  }

  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 30_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Vision rescue timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const result = await client.responses.create({
      model: getVisionModel(),
      input: [
        {
          role: "system",
          content:
            "You analyze Shopee product images for product understanding only. Return strict JSON only. Identify the actual main product shown, not decorative background. Do not infer unrelated categories. Use concise Thai for entity/use case/audience and snake_case for product type when possible."
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Analyze this Shopee product image.

Return JSON only:

{
"visionProductEntity": "",
"visionProductType": "",
"visionMainUseCase": "",
"visionTargetAudience": "",
"visionConfidence": 0,
"visualEvidence": []
}

Rules:
* Identify the actual product shown in the image.
* Focus on the main product, not decorative background.
* Do not infer unrelated categories.
* If the product looks like a candle, return scented_candle or candle.
* If it is a table cover, return tablecloth or waterproof_tablecloth.
* If it is jewelry, return necklace/earring/bracelet/ring as appropriate.
* If unsure, set confidence below 70.

Optional text context, only for disambiguation:
Title: ${input.productTitle ?? ""}
Description: ${input.productDescription ?? ""}`
            },
            { type: "input_image", image_url: input.imageUrl, detail: "high" }
          ]
        }
      ]
    }, { signal: controller.signal });

    const parsed = JSON.parse(extractJson(result.output_text)) as Partial<ShopeeVisionUnderstandingResult>;
    return {
      visionProductEntity: normalizeExtractedText(String(parsed.visionProductEntity ?? "")),
      visionProductType: normalizeExtractedText(String(parsed.visionProductType ?? "")),
      visionMainUseCase: normalizeExtractedText(String(parsed.visionMainUseCase ?? "")),
      visionTargetAudience: normalizeExtractedText(String(parsed.visionTargetAudience ?? "")),
      visionConfidence: Math.max(0, Math.min(100, Number(parsed.visionConfidence ?? 0) || 0)),
      visualEvidence: Array.isArray(parsed.visualEvidence)
        ? parsed.visualEvidence.map((item) => normalizeExtractedText(String(item))).filter(Boolean).slice(0, 8)
        : []
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeThaiBuyerProductIntelligence(input: {
  productTitle: string;
  productDescription?: string;
  category?: string;
  specs?: string;
  price?: number;
  soldCount?: number;
  rating?: number;
  imageProductSummary?: string;
  userId?: string;
}): Promise<ThaiBuyerProductIntelligenceResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Thai buyer product intelligence is not configured: missing OPENAI_API_KEY");
  }

  const model = getContentModel();
  const prompt = `Given the following product data:
- Title: ${input.productTitle}
- Description: ${input.productDescription ?? ""}
- Category: ${input.category ?? ""}
- Specs/Attributes: ${input.specs ?? ""}
- Price: ${input.price ?? 0}
- Sold Count: ${input.soldCount ?? 0}
- Rating: ${input.rating ?? 0}
- Image summary: ${input.imageProductSummary ?? ""}

Analyze this product from the perspective of a REAL Thai buyer, not a marketer.
Think about who actually buys this, when, and why.

Return ONLY a valid JSON object with this exact structure:

{
  "productNameThai": "ชื่อสินค้าภาษาไทยที่เป็นธรรมชาติ",
  "productType": "ประเภทสินค้า",
  "mainPurpose": "จุดประสงค์หลักในการใช้งาน",
  "targetCustomer": "กลุ่มลูกค้าที่ชัดเจน เช่น แม่บ้านที่มีลูกเล็ก, คนทำงานออฟฟิศ",
  "usageScenarios": ["สถานการณ์ใช้งานจริง 1", "สถานการณ์ 2", "สถานการณ์ 3"],
  "keyBenefits": ["ประโยชน์จริงที่รู้สึกได้ 1", "ประโยชน์ 2", "ประโยชน์ 3"],
  "productFacts": ["ข้อมูลจริงจากสินค้า 1", "ข้อมูล 2"],
  "imageProductSummary": "สรุปภาพสินค้า",

  "painPoint": {
    "primary": "ปัญหาหลักที่สินค้านี้แก้ได้ เขียนในมุมคนมีปัญหาจริง เช่น 'รู้สึกหนักใจทุกครั้งที่ต้องล้างจาน ยิ่งมีคราบมัน'",
    "secondary": "ปัญหารองหรือความกังวลก่อนซื้อ เช่น 'กังวลว่าจะแรงเกินไปสำหรับมือ'"
  },

  "triggerMoment": {
    "time": "ช่วงเวลาหรือสถานการณ์ที่คนนึกถึงสินค้านี้ เช่น 'หลังทำอาหารเสร็จแล้วเห็นจานกองสูง'",
    "emotion": "อารมณ์ที่เชื่อมกับสินค้า เช่น 'เหนื่อย, อยากเสร็จเร็ว, อยากให้บ้านสะอาด'",
    "season": "ช่วงเวลา/ฤดู/เทศกาลที่ขายดีเป็นพิเศษ ถ้าไม่มีให้ใส่ null"
  },

  "humanVoice": {
    "howFriendDescribes": "ถ้าเพื่อนบอกต่อเรื่องสินค้านี้จะพูดว่าอะไร ภาษาพูดธรรมชาติ",
    "beforeAfter": "เปรียบเทียบก่อน/หลังใช้ แบบที่คนรีวิวจริงพูด",
    "oneLinerHook": "ประโยคเดียวที่จะทำให้คนหยุดดูโพสต์"
  },

  "contentTone": "เลือก 1 จาก: friend / reviewer / homemaker / expert / storyteller",
  "confidenceScore": 0.0
}

Rules:
- painPoint ต้องเป็นภาษาคนจริง ไม่ใช่ feature list
- triggerMoment.time ต้องระบุ scenario จริง ไม่ใช่แค่ "ทุกวัน"
- humanVoice.howFriendDescribes ต้องใช้ภาษาพูดไม่เป็นทางการ
- ถ้า confidence < 0.70 ให้ระบุเหตุผลใน field "lowConfidenceReason"
- ห้ามใช้คำว่า: คุณภาพดี, คุ้มค่า, เหมาะสำหรับทุกคน, ใช้ได้ทุกโอกาส`;

  const result = await traceExternalRequest(
    {
      step: "THAI_BUYER_PRODUCT_INTELLIGENCE",
      url: "openai://responses.create",
      fn: "analyzeThaiBuyerProductIntelligence",
      source: "openai_product_intelligence",
      userId: input.userId,
      metadata: { model }
    },
    () => client.responses.create({
      model,
      input: [
        {
          role: "system",
          content:
            "You are a Thai consumer psychologist and product analyst. Return strict JSON only. Do not include markdown fences or commentary. Never use generic marketing language."
        },
        { role: "user", content: prompt }
      ]
    })
  );

  const parsed = JSON.parse(extractJson(result.output_text)) as Partial<ThaiBuyerProductIntelligenceResult>;
  const confidenceRaw = Number(parsed.confidenceScore ?? 0) || 0;
  const confidenceScore = confidenceRaw > 1 ? Math.max(0, Math.min(1, confidenceRaw / 100)) : Math.max(0, Math.min(1, confidenceRaw));
  return {
    productNameThai: normalizeExtractedText(String(parsed.productNameThai ?? "")),
    productType: normalizeExtractedText(String(parsed.productType ?? "")),
    mainPurpose: normalizeExtractedText(String(parsed.mainPurpose ?? "")),
    targetCustomer: normalizeExtractedText(String(parsed.targetCustomer ?? "")),
    usageScenarios: Array.isArray(parsed.usageScenarios) ? parsed.usageScenarios.map((item) => normalizeExtractedText(String(item))).filter(Boolean).slice(0, 5) : [],
    keyBenefits: Array.isArray(parsed.keyBenefits) ? parsed.keyBenefits.map((item) => normalizeExtractedText(String(item))).filter(Boolean).slice(0, 5) : [],
    productFacts: Array.isArray(parsed.productFacts) ? parsed.productFacts.map((item) => normalizeExtractedText(String(item))).filter(Boolean).slice(0, 6) : [],
    imageProductSummary: normalizeExtractedText(String(parsed.imageProductSummary ?? "")),
    painPoint: {
      primary: normalizeExtractedText(String(parsed.painPoint?.primary ?? "")),
      secondary: normalizeExtractedText(String(parsed.painPoint?.secondary ?? ""))
    },
    triggerMoment: {
      time: normalizeExtractedText(String(parsed.triggerMoment?.time ?? "")),
      emotion: normalizeExtractedText(String(parsed.triggerMoment?.emotion ?? "")),
      season: parsed.triggerMoment?.season === null ? null : normalizeExtractedText(String(parsed.triggerMoment?.season ?? "")) || null
    },
    humanVoice: {
      howFriendDescribes: normalizeExtractedText(String(parsed.humanVoice?.howFriendDescribes ?? "")),
      beforeAfter: normalizeExtractedText(String(parsed.humanVoice?.beforeAfter ?? "")),
      oneLinerHook: normalizeExtractedText(String(parsed.humanVoice?.oneLinerHook ?? ""))
    },
    contentTone: ["friend", "reviewer", "homemaker", "expert", "storyteller"].includes(String(parsed.contentTone))
      ? parsed.contentTone as ThaiBuyerProductIntelligenceResult["contentTone"]
      : "reviewer",
    confidenceScore,
    lowConfidenceReason: normalizeExtractedText(String(parsed.lowConfidenceReason ?? "")) || undefined
  };
}

export async function generateThaiSocialProductCaption(input: {
  productIntelligence: unknown;
  captionStyle: ThaiSocialCaptionStyle;
  productId: string;
  userId?: string;
}): Promise<ThaiSocialCaptionResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Thai social product caption generation is not configured: missing OPENAI_API_KEY");
  }

  const model = getContentModel();
  const productIntelligenceJSON = JSON.stringify(input.productIntelligence, null, 2);
  const prompt = `คุณคือนักเขียนแคปชัน Facebook Affiliate ภาษาไทยสไตล์เพจขายของไวรัล

ข้อมูลสินค้า:
${productIntelligenceJSON}

Caption Style: ${input.captionStyle}

งาน: เขียนแคปชัน Facebook Affiliate สั้น กระชับ ดึงดูด สำหรับสินค้านี้

กฎเหล็กที่ต้องทำตามอย่างเคร่งครัด:
- ความยาวไม่เกิน 2 บรรทัด
- ไม่เกิน 20 คำ
- เขียนเหมือนเพจขายของไวรัล ที่คนหยุดเลื่อนทันที
- เน้นจุดขายที่แรงที่สุดเพียง 1 จุด จาก painPoint หรือ triggerMoment
- ห้ามรีวิว
- ห้ามเล่าเรื่อง
- ห้าม Bullet points
- ห้าม Hashtag
- ห้ามใช้: เหมาะสำหรับ, คุ้มค่า, คุ้มราคา, ใช้งานได้หลากหลาย, สินค้าคุณภาพดี, ตอบโจทย์, ไม่ควรพลาด, รีบสั่ง
- ห้ามอธิบายยาว ห้ามเล่าสเปก
- ห้ามใส่ราคา คะแนนรีวิว หรือ URL ใน captionText (ระบบจะเพิ่ม link ให้เอง)

รูปแบบผลลัพธ์ที่ต้องการ:
บรรทัดที่ 1: Hook สั้น ๆ ที่ทำให้คนหยุดเลื่อน พร้อม Emoji 1-2 ตัวที่เหมาะสม
(ไม่มีบรรทัดว่าง ไม่มี CTA บรรทัดแยก)

ตัวอย่างที่ดี:
- "เย็นข้ามวันข้ามคืน ❗ ถังแช่น้ำแข็ง 95 ลิตร เก็บความเย็นได้นานมาก 🧊"
- "ขนได้ทีเดียว 20 กิโล ไม่ปวดหลังอีกต่อไป 💪"
- "นอนหลับทั้งคืนไม่ตื่นมาร้อน ❄️ ผ้าปูที่นอนเย็นสบาย ลืมแอร์ไปได้เลย"

Output Format (JSON):
{
  "captionText": "Hook 1 บรรทัด ไม่เกิน 20 คำ",
  "style": "${input.captionStyle}",
  "tone": "viral",
  "openingType": "hook",
  "wordCount": 0,
  "emojiCount": 0,
  "genericWordsFound": [],
  "qualityScore": 0.0,
  "productId": "${input.productId}"
}

Hard Rules สุดท้าย:
- captionText ต้องเป็น 1 บรรทัดเท่านั้น (ไม่มี \\n)
- ห้ามขึ้นต้นด้วยชื่อสินค้า
- ต้องมี Emoji อย่างน้อย 1 ตัว
- ใช้ข้อมูลจริงจาก painPoint หรือ triggerMoment เท่านั้น ห้ามแต่งเอง`;

  const result = await traceExternalRequest(
    {
      step: "THAI_SOCIAL_CAPTION_GENERATION",
      url: "openai://responses.create",
      fn: "generateThaiSocialProductCaption",
      source: "openai_social_caption_generation",
      userId: input.userId,
      metadata: { model, captionStyle: input.captionStyle }
    },
    () => client.responses.create({
      model,
      input: [
        {
          role: "system",
          content:
            "คุณเขียนแคปชัน Facebook Affiliate ภาษาไทยสไตล์เพจขายของไวรัล สั้น กระชับ ไม่เกิน 1 บรรทัด ไม่เกิน 20 คำ มี Emoji ห้าม Bullet ห้าม Hashtag ห้ามรีวิว ห้ามเล่าเรื่อง Return strict JSON only."
        },
        { role: "user", content: prompt }
      ]
    })
  );

  const parsed = JSON.parse(extractJson(result.output_text)) as Partial<ThaiSocialCaptionResult>;
  const qualityRaw = Number(parsed.qualityScore ?? 0) || 0;
  const qualityScore = qualityRaw > 1 ? Math.max(0, Math.min(1, qualityRaw / 100)) : Math.max(0, Math.min(1, qualityRaw));
  const style = parsed.style === input.captionStyle ? parsed.style : input.captionStyle;
  const openingType = ["emotion", "question", "fact", "scene", "hook"].includes(String(parsed.openingType))
    ? parsed.openingType as ThaiSocialCaptionResult["openingType"]
    : "hook";
  return {
    captionText: normalizeExtractedText(String(parsed.captionText ?? "")),
    style,
    tone: normalizeExtractedText(String(parsed.tone ?? "")) || "natural",
    openingType,
    wordCount: Math.max(0, Number(parsed.wordCount ?? 0) || 0),
    emojiCount: Math.max(0, Number(parsed.emojiCount ?? 0) || 0),
    genericWordsFound: Array.isArray(parsed.genericWordsFound)
      ? parsed.genericWordsFound.map((item) => normalizeExtractedText(String(item))).filter(Boolean)
      : [],
    qualityScore,
    productId: normalizeExtractedText(String(parsed.productId ?? input.productId)) || input.productId
  };
}

export async function generateThaiLifestyleImagePrompt(input: {
  productIntelligence: unknown;
  captionStyle: ThaiSocialCaptionStyle;
  productId: string;
  userId?: string;
}): Promise<ThaiLifestyleImagePromptResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Thai lifestyle image prompt generation is not configured: missing OPENAI_API_KEY");
  }

  const model = getContentModel();
  const productIntelligenceJSON = JSON.stringify(input.productIntelligence, null, 2);
  const prompt = `You are a creative director for Thai lifestyle social media content.

Product Intelligence Input:
${productIntelligenceJSON}

Caption Style Used: ${input.captionStyle}

Your job is to create an image generation prompt that shows the product in a REAL-LIFE CONTEXT,
not a product shot or white background photo.

The image should match the emotion and scene from the caption, not just show the product.

Return ONLY a valid JSON object:

{
  "imagePrompt": {
    "scene": "อธิบาย scene ที่เห็นในภาพ เช่น 'ครัวบ้านไทยตอนเย็น มีจานกองอยู่ในอ่าง'",
    "subject": "สิ่งที่เป็น main focus ของภาพ",
    "productPlacement": "สินค้าอยู่ตรงไหนในภาพ ทำอะไรอยู่",
    "mood": "อารมณ์ของภาพ เช่น warm, satisfying, cozy, energetic",
    "lighting": "แสงที่ใช้ เช่น golden hour, soft natural light, bright kitchen light",
    "colorPalette": "โทนสีหลัก เช่น warm earth tones, clean white and green",
    "humanPresence": "มีคนในภาพไหม ถ้ามีเป็นใคร ทำอะไร (ไม่ต้องเห็นหน้า)",
    "avoidElements": ["สิ่งที่ไม่ควรมีในภาพ"],
    "styleReference": "สไตล์ภาพ เช่น UGC photo, lifestyle editorial, candid home photo",
    "fullPrompt": "prompt รวมทั้งหมดในภาษาอังกฤษสำหรับส่งให้ image AI"
  },
  "productId": "${input.productId}",
  "matchesCaptionMood": true,
  "confidenceScore": 0.0
}

Rules:
- fullPrompt ต้องเป็นภาษาอังกฤษ
- ห้ามใช้ white background, product shot, studio lighting ถ้าไม่ใช่สินค้าที่จำเป็น
- scene ต้องสอดคล้องกับ triggerMoment.time จาก Product Intelligence
- mood ต้องสอดคล้องกับ captionStyle ที่ใช้
- ถ้า captionStyle เป็น "story" → ภาพต้องดู candid/real
- ถ้า captionStyle เป็น "shock_hook" → ภาพต้องมี visual contrast ที่น่าสนใจ
- humanPresence แนะนำให้มีคนบางส่วน (มือ, เงา) เพื่อให้ดูเป็นธรรมชาติ`;

  const result = await traceExternalRequest(
    {
      step: "THAI_LIFESTYLE_IMAGE_PROMPT_GENERATION",
      url: "openai://responses.create",
      fn: "generateThaiLifestyleImagePrompt",
      source: "openai_image_prompt_generation",
      userId: input.userId,
      metadata: { model, captionStyle: input.captionStyle }
    },
    () => client.responses.create({
      model,
      input: [
        {
          role: "system",
          content:
            "You are a creative director for Thai lifestyle social content. Return strict JSON only. fullPrompt must be English. Never propose white background, product-only packshot, studio lighting, ad layout, text overlays, or fake labels."
        },
        { role: "user", content: prompt }
      ]
    })
  );

  const parsed = JSON.parse(extractJson(result.output_text)) as Partial<ThaiLifestyleImagePromptResult>;
  const confidenceRaw = Number(parsed.confidenceScore ?? 0) || 0;
  const confidenceScore = confidenceRaw > 1 ? Math.max(0, Math.min(1, confidenceRaw / 100)) : Math.max(0, Math.min(1, confidenceRaw));
  const imagePrompt = (parsed.imagePrompt ?? {}) as Partial<ThaiLifestyleImagePromptResult["imagePrompt"]>;
  return {
    imagePrompt: {
      scene: normalizeExtractedText(String(imagePrompt.scene ?? "")),
      subject: normalizeExtractedText(String(imagePrompt.subject ?? "")),
      productPlacement: normalizeExtractedText(String(imagePrompt.productPlacement ?? "")),
      mood: normalizeExtractedText(String(imagePrompt.mood ?? "")),
      lighting: normalizeExtractedText(String(imagePrompt.lighting ?? "")),
      colorPalette: normalizeExtractedText(String(imagePrompt.colorPalette ?? "")),
      humanPresence: normalizeExtractedText(String(imagePrompt.humanPresence ?? "")),
      avoidElements: Array.isArray(imagePrompt.avoidElements)
        ? imagePrompt.avoidElements.map((item: unknown) => normalizeExtractedText(String(item))).filter(Boolean).slice(0, 12)
        : [],
      styleReference: normalizeExtractedText(String(imagePrompt.styleReference ?? "")),
      fullPrompt: normalizeExtractedText(String(imagePrompt.fullPrompt ?? ""))
    },
    productId: normalizeExtractedText(String(parsed.productId ?? input.productId)) || input.productId,
    matchesCaptionMood: parsed.matchesCaptionMood === true,
    confidenceScore
  };
}

export async function generateOptimizationSuggestions(input: OptimizationInput) {
  const result = await client.responses.create({
    model: getAnalyticsModel(),
    input: [
      {
        role: "system",
        content:
          "You analyze Facebook post performance. Return strict JSON with keys improvedCaption, whyItMayPerformBetter, suggestedPostingWindows, and abTestIdeas. Keep suggestions concise and practical."
      },
      {
        role: "user",
        content: `Caption: ${input.caption}\nPerformance notes: ${input.performanceNotes}\nGoal: ${input.goal ?? "Improve engagement while staying natural and on-brand."}`
      }
    ]
  });

  return JSON.parse(extractJson(result.output_text)) as {
    improvedCaption: string;
    whyItMayPerformBetter: string[];
    suggestedPostingWindows: string[];
    abTestIdeas: string[];
  };
}

export async function generateMultiImagePersonalityReplies(input: {
  imageSummaries: string[];
  caption: string;
}): Promise<MultiImagePersonalityReply[]> {
  const fallback = input.imageSummaries.map((summary, index) => ({
    optionKey: String(index + 1),
    replyText: `ถ้าเลือกข้อ ${index + 1} แปลว่าคุณเป็นคนมีสไตล์ของตัวเอง ชอบฟีล ${summary.toLowerCase()} และมักดึงดูดคนรอบตัวแบบไม่ต้องพยายามมาก`
  }));

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const result = await client.responses.create({
      model: getContentModel(),
      input: [
        {
          role: "system",
          content:
            "You write Thai auto-reply text for Facebook comments. Return strict JSON with a replies array. Each item must have optionKey and replyText. replyText must be 1-2 sentences, warm, playful, personality-reading style, and matched to the specific nail idea summary. No hashtags. No markdown."
        },
        {
          role: "user",
          content: JSON.stringify(input)
        }
      ]
    });

    const parsed = JSON.parse(extractJson(result.output_text)) as { replies?: MultiImagePersonalityReply[] };
    return parsed.replies?.length ? parsed.replies : fallback;
  } catch {
    return fallback;
  }
}

export async function classifyCaptionIntent(caption: string) {
  const result = await client.responses.create({
    model: getLightweightModel(),
    input: [
      {
        role: "system",
        content:
          "Classify the caption intent. Return strict JSON with keys intent and riskLevel. intent must be one of sales, education, entertainment, community, announcement. riskLevel must be one of low, medium, high."
      },
      {
        role: "user",
        content: caption
      }
    ]
  });

  return JSON.parse(extractJson(result.output_text)) as {
    intent: "sales" | "education" | "entertainment" | "community" | "announcement";
    riskLevel: "low" | "medium" | "high";
  };
}

export async function extractExactTextFromImage(imageBytes: ArrayBuffer, mimeType: string) {
  if (!process.env.OPENAI_API_KEY) {
    return "";
  }

  const base64 = Buffer.from(imageBytes).toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const result = await client.responses.create({
    model: getContentModel(),
    input: [
      {
        role: "system",
        content:
          "Extract all visible text from the image exactly as written. Do not translate, summarize, rewrite, improve, or add any extra words. Preserve separate lines where possible. If there is no readable text, return an empty string."
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Return only the exact text found in this image." },
          { type: "input_image", image_url: dataUrl, detail: "high" }
        ]
      }
    ]
  });

  return normalizeExtractedText(result.output_text);
}

export async function extractPrimaryCreativeTextFromImage(imageBytes: ArrayBuffer, mimeType: string) {
  if (!process.env.OPENAI_API_KEY) {
    return "";
  }

  const base64 = Buffer.from(imageBytes).toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const result = await client.responses.create({
    model: getContentModel(),
    input: [
      {
        role: "system",
        content:
          "Extract only the main text that appears inside the creative itself. If the image is a screenshot of a social post, ignore app UI, timestamps, page names, captions above the image, menus, buttons, and navigation labels. Focus on the central poster, meme, quote card, or designed image. Return only the visible text from that creative, preserving line breaks where appropriate. Do not rewrite or add words."
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Return only the primary text inside the creative image." },
          { type: "input_image", image_url: dataUrl, detail: "high" }
        ]
      }
    ]
  });

  return normalizeExtractedText(result.output_text);
}

export async function describeVisualStyleFromImage(imageBytes: ArrayBuffer, mimeType: string) {
  if (!process.env.OPENAI_API_KEY) {
    return "";
  }

  const base64 = Buffer.from(imageBytes).toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const result = await client.responses.create({
    model: getContentModel(),
    input: [
      {
        role: "system",
        content:
          "Describe the visible nail design in the image as a short Thai phrase only. Focus on style, mood, color, and standout details. Ignore app UI, captions, page names, timestamps, and file-like text. Return 1 short phrase, around 4 to 10 Thai words. Do not use hashtags. Do not say that no text was found."
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe the nail style in this image as a short Thai phrase." },
          { type: "input_image", image_url: dataUrl, detail: "high" }
        ]
      }
    ]
  });

  return normalizeExtractedText(result.output_text);
}

type TrendFactSheet = {
  who: string[];
  what: string[];
  where: string[];
  when: string[];
  whyItMatters: string[];
  quotes: string[];
  sensitivePoints: string[];
  uncertaintyFlags: string[];
  sourceReferences: Array<{ title: string; url: string }>;
};

type TrendStrategyChoice = {
  chosenStrategy: "emotional_story" | "breaking_explain" | "drama_timeline" | "human_interest_longform";
  chosenGoal: "maximize_shares" | "maximize_time_spend" | "maximize_engagement" | "maximize_trust";
  rationale: string;
};

type TrendContentPackageResult = {
  headlineVariants: string[];
  captionVariants: string[];
  bodyDraft: string;
  imageOverlayVariants: Array<{
    headlineText: string;
    subheadlineText: string;
    highlightWords: string[];
  }>;
};

type TrendReviewResult = {
  factConsistencyScore: number;
  readabilityScore: number;
  emotionalScore: number;
  shareabilityScore: number;
  estimatedTimeSpendScore: number;
  trustScore: number;
  riskScore: number;
  flags: string[];
  decision: "approved_for_draft" | "needs_review" | "rejected";
};

export async function generateTrendFactSheet(input: {
  articleTitle: string;
  articleUrl: string;
  articleSummary?: string;
  fullContent?: string;
}): Promise<TrendFactSheet> {
  const fallback: TrendFactSheet = {
    who: [],
    what: [input.articleTitle],
    where: [],
    when: [],
    whyItMatters: [input.articleSummary?.trim() || "เป็นประเด็นที่ควรตรวจสอบก่อนเผยแพร่จริง"],
    quotes: [],
    sensitivePoints: [],
    uncertaintyFlags: ["ควรตรวจสอบข้อเท็จจริงและรายละเอียดเพิ่มเติมจากแหล่งข่าวต้นทาง"],
    sourceReferences: [{ title: input.articleTitle, url: input.articleUrl }]
  };

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const result = await client.responses.create({
      model: getContentModel(),
      input: [
        {
          role: "system",
          content:
            "You are a fact extraction analyst for Thai Facebook news drafting. Return strict JSON with keys who, what, where, when, whyItMatters, quotes, sensitivePoints, uncertaintyFlags, sourceReferences. Extract only supported facts. If something is unclear, put it in uncertaintyFlags."
        },
        {
          role: "user",
          content: `Article title: ${input.articleTitle}\nArticle URL: ${input.articleUrl}\nSummary: ${input.articleSummary ?? ""}\nFull content: ${input.fullContent ?? ""}`
        }
      ]
    });

    const parsed = JSON.parse(extractJson(result.output_text)) as TrendFactSheet;
    return {
      ...fallback,
      ...parsed,
      sourceReferences: parsed.sourceReferences?.length
        ? parsed.sourceReferences
        : [{ title: input.articleTitle, url: input.articleUrl }]
    };
  } catch {
    return fallback;
  }
}

export async function generateTrendStrategy(input: {
  label: string;
  summary: string;
  emotionType: string;
  hotLevel: string;
  factSheet: TrendFactSheet;
  preferredGoal: "maximize_shares" | "maximize_time_spend" | "maximize_engagement" | "maximize_trust";
}): Promise<TrendStrategyChoice> {
  const fallback: TrendStrategyChoice = {
    chosenStrategy:
      input.emotionType === "human_interest"
        ? "human_interest_longform"
        : input.hotLevel === "surging"
          ? "breaking_explain"
          : "drama_timeline",
    chosenGoal: input.preferredGoal,
    rationale: "เลือกตามอารมณ์ของประเด็น ความร้อนแรงของเทรนด์ และ goal เริ่มต้นที่ตั้งไว้"
  };

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const result = await client.responses.create({
      model: getLightweightModel(),
      input: [
        {
          role: "system",
          content:
            "You are a Facebook editorial strategist. Choose one strategy from emotional_story, breaking_explain, drama_timeline, human_interest_longform and one goal from maximize_shares, maximize_time_spend, maximize_engagement, maximize_trust. Return strict JSON with chosenStrategy, chosenGoal, rationale."
        },
        {
          role: "user",
          content: JSON.stringify(input)
        }
      ]
    });

    return JSON.parse(extractJson(result.output_text)) as TrendStrategyChoice;
  } catch {
    return fallback;
  }
}

export async function generateTrendContentPackage(input: {
  topicLabel: string;
  topicSummary: string;
  factSheet: TrendFactSheet;
  strategy: TrendStrategyChoice;
}): Promise<TrendContentPackageResult> {
  const fallback: TrendContentPackageResult = {
    headlineVariants: [
      `จับตา ${input.topicLabel}`,
      `สรุปประเด็น ${input.topicLabel}`,
      `เกิดอะไรขึ้นกับ ${input.topicLabel}`
    ],
    captionVariants: [
      `ประเด็นนี้กำลังถูกพูดถึงมากขึ้นเรื่อยๆ\n\n${input.topicSummary}\n\nคุณมองเรื่องนี้อย่างไรบ้าง?`,
      `สรุปสั้นๆ ของประเด็น ${input.topicLabel}\n\n${input.factSheet.whyItMatters[0] ?? input.topicSummary}\n\nคิดเห็นยังไงกับเรื่องนี้ คอมเมนต์ได้เลย`
    ],
    bodyDraft: [
      input.factSheet.what[0] ?? input.topicSummary,
      input.factSheet.whyItMatters[0] ?? "",
      input.factSheet.uncertaintyFlags[0] ?? ""
    ]
      .filter(Boolean)
      .join("\n\n"),
    imageOverlayVariants: [
      {
        headlineText: `จับตา ${input.topicLabel}`,
        subheadlineText: "เล่าใหม่แบบเข้าใจง่ายจากข่าวที่ตรวจสอบแล้ว",
        highlightWords: [...input.factSheet.who.slice(0, 2), ...input.factSheet.what.slice(0, 2)].slice(0, 4)
      }
    ]
  };

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const result = await client.responses.create({
      model: getContentModel(),
      input: [
        {
          role: "system",
          content:
            "You write Thai Facebook news content for Prosocial System. Generate strict JSON with headlineVariants (3-5), captionVariants (2-3), bodyDraft (string), imageOverlayVariants (2-3 objects with headlineText, subheadlineText, highlightWords). The content must be fact-grounded, emotionally engaging but trustworthy, suitable for Facebook posting, and written as our own retelling of the news. Headlines should feel strong and clickable without inventing facts. Image overlays should feel like a compelling Thai news poster, ideally highlighting the key person/entity in the story and a sharp hook."
        },
        {
          role: "user",
          content: JSON.stringify(input)
        }
      ]
    });

    const parsed = JSON.parse(extractJson(result.output_text)) as TrendContentPackageResult;
    return {
      headlineVariants: parsed.headlineVariants?.length ? parsed.headlineVariants : fallback.headlineVariants,
      captionVariants: parsed.captionVariants?.length ? parsed.captionVariants : fallback.captionVariants,
      bodyDraft: parsed.bodyDraft?.trim() ? parsed.bodyDraft : fallback.bodyDraft,
      imageOverlayVariants: parsed.imageOverlayVariants?.length ? parsed.imageOverlayVariants : fallback.imageOverlayVariants
    };
  } catch {
    return fallback;
  }
}

export async function reviewTrendContentPackage(input: {
  factSheet: TrendFactSheet;
  strategy: TrendStrategyChoice;
  content: TrendContentPackageResult;
}): Promise<TrendReviewResult> {
  const fallback: TrendReviewResult = {
    factConsistencyScore: 0.82,
    readabilityScore: 0.78,
    emotionalScore: 0.74,
    shareabilityScore: 0.72,
    estimatedTimeSpendScore: 0.76,
    trustScore: 0.8,
    riskScore: 0.28,
    flags: [],
    decision: "needs_review"
  };

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const result = await client.responses.create({
      model: getLightweightModel(),
      input: [
        {
          role: "system",
          content:
            "You are a strict reviewer for social news content. Return strict JSON with factConsistencyScore, readabilityScore, emotionalScore, shareabilityScore, estimatedTimeSpendScore, trustScore, riskScore, flags, and decision. decision must be approved_for_draft, needs_review, or rejected."
        },
        {
          role: "user",
          content: JSON.stringify(input)
        }
      ]
    });

    return JSON.parse(extractJson(result.output_text)) as TrendReviewResult;
  } catch {
    return fallback;
  }
}
