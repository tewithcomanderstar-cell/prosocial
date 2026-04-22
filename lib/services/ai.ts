import OpenAI from "openai";
import { getFallbackVariants } from "@/lib/services/fallback-content";
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
    const result = await client.responses.create({
      model: getContentModel(),
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
    });

    const parsed = JSON.parse(extractJson(result.output_text)) as { variants: GeneratedVariant[] };
    return parsed.variants;
  } catch {
    return getFallbackVariants(options.userId ?? null, keyword);
  }
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
        subheadlineText: "สรุปจากแหล่งข่าวที่จับคู่ได้",
        highlightWords: input.factSheet.who.slice(0, 3)
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
            "You write Thai Facebook content for Prosocial System. Generate strict JSON with headlineVariants (3-5), captionVariants (2-3), bodyDraft (string), imageOverlayVariants (2-3 objects with headlineText, subheadlineText, highlightWords). All outputs must be fact-grounded, emotionally engaging but trustworthy, and suitable for Facebook draft/review flow."
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
