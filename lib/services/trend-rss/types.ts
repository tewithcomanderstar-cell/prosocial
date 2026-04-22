export type TrendMode = "trend_rss_news_mode";

export type TrendGoal =
  | "maximize_shares"
  | "maximize_time_spend"
  | "maximize_engagement"
  | "maximize_trust";

export type TrendStrategyName =
  | "emotional_story"
  | "breaking_explain"
  | "drama_timeline"
  | "human_interest_longform";

export type FactSheet = {
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

export type TrendStrategy = {
  chosenStrategy: TrendStrategyName;
  chosenGoal: TrendGoal;
  rationale: string;
};

export type TrendContentPackage = {
  headlineVariants: string[];
  captionVariants: string[];
  bodyDraft: string;
  imageOverlayVariants: Array<{
    headlineText: string;
    subheadlineText: string;
    highlightWords: string[];
  }>;
};

export type TrendReviewScores = {
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

export type TrendImagePayload = {
  mode: TrendMode;
  templateId?: string | null;
  selectedImages: string[];
  headlineText: string;
  subheadlineText?: string;
  highlightWords: string[];
  cropHints: Array<{ assetId?: string; focus: string }>;
};
