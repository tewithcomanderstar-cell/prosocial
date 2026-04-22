import { ContentItem } from "@/models/ContentItem";
import type { FactSheet, TrendImagePayload, TrendReviewScores } from "@/lib/services/trend-rss/types";

export async function createTrendRssDraft(input: {
  userId: string;
  destinationPageIds: string[];
  topicMetadata: Record<string, unknown>;
  resolvedArticleMetadata: Record<string, unknown>;
  factSheet: FactSheet;
  selectedHeadline: string;
  selectedCaption: string;
  generatedBody: string;
  imagePayload: TrendImagePayload;
  qualityScores: TrendReviewScores;
  reviewStatus: "draft" | "needs_review" | "rejected";
  sourceTraceabilityMetadata: Record<string, unknown>;
}) {
  const bodyText = [input.selectedCaption, input.generatedBody].filter(Boolean).join("\n\n");
  return ContentItem.create({
    createdBy: input.userId,
    title: input.selectedHeadline,
    bodyText,
    mode: "trend_rss_news_mode",
    status: input.reviewStatus === "draft" ? "draft" : input.reviewStatus === "needs_review" ? "pending_review" : "draft",
    platformPayloadJson: {
      mode: "trend_rss_news_mode",
      topicMetadata: input.topicMetadata,
      resolvedArticleMetadata: input.resolvedArticleMetadata,
      selectedHeadline: input.selectedHeadline,
      selectedCaption: input.selectedCaption,
      generatedBody: input.generatedBody
    },
    sourceTraceJson: input.sourceTraceabilityMetadata,
    factSheetJson: input.factSheet,
    reviewScoresJson: input.qualityScores,
    imagePayloadJson: input.imagePayload,
    generationMetaJson: {
      reviewStatus: input.reviewStatus
    },
    destinationIds: input.destinationPageIds,
    approvalRequired: true
  });
}
