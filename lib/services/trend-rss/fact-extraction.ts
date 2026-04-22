import { generateTrendFactSheet } from "@/lib/services/ai";
import type { FactSheet } from "@/lib/services/trend-rss/types";

export async function extractTrendFactSheet(input: {
  articleTitle: string;
  articleUrl: string;
  articleSummary?: string;
  fullContent?: string;
}): Promise<FactSheet> {
  return generateTrendFactSheet(input);
}
