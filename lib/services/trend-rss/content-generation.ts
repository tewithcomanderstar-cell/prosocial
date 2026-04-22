import { generateTrendContentPackage } from "@/lib/services/ai";
import type { FactSheet, TrendContentPackage, TrendStrategy } from "@/lib/services/trend-rss/types";

export async function generateTrendContent(input: {
  topicLabel: string;
  topicSummary: string;
  factSheet: FactSheet;
  strategy: TrendStrategy;
}): Promise<TrendContentPackage> {
  return generateTrendContentPackage(input);
}
