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

  return `${personaPrompt}\n\nTopic or keyword:\n${keyword}\n\n${promptInstruction}\n\n${sourceBlock}`;
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
            "You write Thai Facebook marketing content. Treat the custom prompt like a real ChatGPT instruction from the user and follow it closely. Use the source material when provided, but do not invent facts beyond it. Return strict JSON with a variants array of 3 to 5 items. Each item must include caption and hashtags. Keep captions ready to post, natural, audience-aware, and aligned to the requested persona and prompt."
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
