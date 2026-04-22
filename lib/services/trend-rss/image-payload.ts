import type { TrendContentPackage, TrendImagePayload } from "@/lib/services/trend-rss/types";

export function buildTrendImagePayload(input: {
  templateId?: string | null;
  selectedImages?: string[];
  content: TrendContentPackage;
}): TrendImagePayload {
  const overlay = input.content.imageOverlayVariants[0] ?? {
    headlineText: input.content.headlineVariants[0] ?? "จับกระแสข่าวล่าสุด",
    subheadlineText: "",
    highlightWords: []
  };

  return {
    mode: "trend_rss_news_mode",
    templateId: input.templateId ?? null,
    selectedImages: input.selectedImages ?? [],
    headlineText: overlay.headlineText,
    subheadlineText: overlay.subheadlineText,
    highlightWords: overlay.highlightWords,
    cropHints: (input.selectedImages ?? []).slice(0, 1).map(() => ({ focus: "headline" }))
  };
}
