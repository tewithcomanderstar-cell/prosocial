import { reviewTrendContentPackage } from "@/lib/services/ai";
import type { FactSheet, TrendContentPackage, TrendReviewScores, TrendStrategy } from "@/lib/services/trend-rss/types";

export async function reviewTrendContent(input: {
  factSheet: FactSheet;
  strategy: TrendStrategy;
  content: TrendContentPackage;
}): Promise<TrendReviewScores> {
  return reviewTrendContentPackage(input);
}
