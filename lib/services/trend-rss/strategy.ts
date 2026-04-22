import { generateTrendStrategy } from "@/lib/services/ai";
import type { FactSheet, TrendGoal, TrendStrategy } from "@/lib/services/trend-rss/types";

export async function chooseTrendStrategy(input: {
  label: string;
  summary: string;
  emotionType: string;
  hotLevel: string;
  factSheet: FactSheet;
  preferredGoal: TrendGoal;
}): Promise<TrendStrategy> {
  return generateTrendStrategy(input);
}
