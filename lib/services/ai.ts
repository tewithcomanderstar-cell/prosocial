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

export async function generateFacebookContent(keyword: string, persona?: PersonaContext, userId?: string) {
  const personaPrompt = persona
    ? `Target page persona: ${persona.pageName ?? "Unnamed page"}. Tone: ${persona.tone ?? "professional"}. Content style: ${persona.contentStyle ?? "sales"}. Audience: ${persona.audience ?? "general audience"}. Extra notes: ${persona.promptNotes ?? "none"}.`
    : "No page persona was provided. Use a practical Thai Facebook marketing tone.";

  if (!process.env.OPENAI_API_KEY) {
    return getFallbackVariants(userId ?? null, keyword);
  }

  try {
    const result = await client.responses.create({
      model: getContentModel(),
      input: [
        {
          role: "system",
          content:
            "You write Thai Facebook marketing content. Return strict JSON with a variants array of 3 to 5 items. Each item must include caption and hashtags. Keep captions ready to post, natural, audience-aware, and aligned to the requested persona."
        },
        {
          role: "user",
          content: `${personaPrompt}\nKeyword: ${keyword}`
        }
      ]
    });

    const parsed = JSON.parse(extractJson(result.output_text)) as { variants: GeneratedVariant[] };
    return parsed.variants;
  } catch {
    return getFallbackVariants(userId ?? null, keyword);
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
