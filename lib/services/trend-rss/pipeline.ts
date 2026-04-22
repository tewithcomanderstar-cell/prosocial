import { TrendRssNewsConfig } from "@/models/TrendRssNewsConfig";
import { TrendTopicCluster } from "@/models/TrendTopicCluster";
import { TrendArticleResolution } from "@/models/TrendArticleResolution";
import { connectDb } from "@/lib/db";
import { ingestTrackedFacebookTrendPosts } from "@/lib/services/trend-rss/facebook-ingestion";
import { ingestRssArticles } from "@/lib/services/trend-rss/rss-ingestion";
import { clusterTrendTopics } from "@/lib/services/trend-rss/topic-clustering";
import { resolveTopicClusterToArticle } from "@/lib/services/trend-rss/topic-resolver";
import { extractTrendFactSheet } from "@/lib/services/trend-rss/fact-extraction";
import { chooseTrendStrategy } from "@/lib/services/trend-rss/strategy";
import { generateTrendContent } from "@/lib/services/trend-rss/content-generation";
import { reviewTrendContent } from "@/lib/services/trend-rss/critic";
import { buildTrendImagePayload } from "@/lib/services/trend-rss/image-payload";
import { createTrendRssDraft } from "@/lib/services/trend-rss/draft-integration";
import { logTrendStage } from "@/lib/services/trend-rss/execution-log";

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export async function runTrendRssPipeline(input: {
  userId: string;
  source: "manual" | "schedule";
  force?: boolean;
}) {
  await connectDb();
  const config = await TrendRssNewsConfig.findOne({ userId: input.userId });

  if (!config) {
    throw new Error("Trend RSS config not found");
  }

  if (!config.enabled && !input.force) {
    return { started: false, reason: "mode_disabled" };
  }

  await TrendRssNewsConfig.findOneAndUpdate(
    { userId: input.userId },
    { status: "running", lastError: null }
  );

  await logTrendStage({
    userId: input.userId,
    stage: "pipeline_start",
    message: "Trend RSS pipeline started",
    metadata: { source: input.source }
  });

  try {
    const facebookResult = await ingestTrackedFacebookTrendPosts(input.userId);
    const rssResult = await ingestRssArticles(input.userId);
    const clusterResult = await clusterTrendTopics(input.userId);

    const hotClusters = await TrendTopicCluster.find({
      userId: input.userId,
      status: { $in: ["detected", "resolved"] },
      trendScore: { $gte: 4 }
    })
      .sort({ trendScore: -1, detectedAt: -1 })
      .limit(5)
      .lean();

    let draftsCreated = 0;

    for (const cluster of hotClusters as Array<any>) {
      const resolved = await resolveTopicClusterToArticle(input.userId, String(cluster._id));
      if (!resolved) {
        await logTrendStage({
          userId: input.userId,
          topicClusterId: String(cluster._id),
          stage: "resolve_skipped",
          message: "No RSS article matched this trend cluster",
          metadata: { label: cluster.label },
          level: "warn"
        });
        continue;
      }

      const factSheet = await extractTrendFactSheet({
        articleTitle: resolved.primaryArticle.title,
        articleUrl: resolved.primaryArticle.url,
        articleSummary: resolved.primaryArticle.summary,
        fullContent: resolved.primaryArticle.fullContent
      });

      const strategy = await chooseTrendStrategy({
        label: cluster.label,
        summary: cluster.summary,
        emotionType: cluster.emotionType,
        hotLevel: cluster.hotLevel,
        factSheet,
        preferredGoal: config.strategyGoal
      });

      const content = await generateTrendContent({
        topicLabel: cluster.label,
        topicSummary: cluster.summary,
        factSheet,
        strategy
      });

      const review = await reviewTrendContent({
        factSheet,
        strategy,
        content
      });

      if (review.decision === "rejected") {
        await TrendTopicCluster.findByIdAndUpdate(cluster._id, { status: "rejected" });
        await logTrendStage({
          userId: input.userId,
          topicClusterId: String(cluster._id),
          stage: "content_rejected",
          message: "Trend content rejected by critic stage",
          metadata: { flags: review.flags, riskScore: review.riskScore },
          level: "warn"
        });
        continue;
      }

      const resolutionDoc = (await TrendArticleResolution.findOne({
        userId: input.userId,
        topicClusterId: cluster._id
      }).lean()) as { confidenceScore?: number } | null;
      const sourcePosts = (cluster.sourcePostIds ?? []).map(String);
      const imagePayload = buildTrendImagePayload({
        templateId: config.templateId,
        selectedImages: [],
        content
      });

      const draft = await createTrendRssDraft({
        userId: input.userId,
        destinationPageIds: config.destinationPageIds ?? [],
        topicMetadata: {
          id: String(cluster._id),
          label: cluster.label,
          summary: cluster.summary,
          emotionType: cluster.emotionType,
          trendScore: cluster.trendScore,
          hotLevel: cluster.hotLevel
        },
        resolvedArticleMetadata: {
          primaryArticleId: String(resolved.primaryArticle._id),
          supportingArticleIds: resolved.supportingArticles.map((article) => String(article._id)),
          confidenceScore: resolutionDoc?.confidenceScore ?? 0
        },
        factSheet,
        selectedHeadline: content.headlineVariants[0] ?? resolved.primaryArticle.title,
        selectedCaption: content.captionVariants[0] ?? resolved.primaryArticle.summary ?? "",
        generatedBody: content.bodyDraft,
        imagePayload,
        qualityScores: review,
        reviewStatus: review.decision === "approved_for_draft" && !config.safeDraftMode ? "draft" : "needs_review",
        sourceTraceabilityMetadata: {
          facebookPostIds: sourcePosts,
          articleIds: [
            String(resolved.primaryArticle._id),
            ...resolved.supportingArticles.map((article) => String(article._id))
          ],
          urls: [resolved.primaryArticle.url, ...resolved.supportingArticles.map((article) => article.url)]
        }
      });

      draftsCreated += 1;

      await TrendTopicCluster.findByIdAndUpdate(cluster._id, {
        status: review.decision === "approved_for_draft" && !config.safeDraftMode ? "generated" : "needs_review"
      });

      await TrendRssNewsConfig.findOneAndUpdate({ userId: input.userId }, { lastDraftId: draft._id });

      await logTrendStage({
        userId: input.userId,
        topicClusterId: String(cluster._id),
        contentItemId: String(draft._id),
        stage: "draft_created",
        message: "Trend RSS draft created",
        metadata: {
          draftId: String(draft._id),
          headline: content.headlineVariants[0] ?? resolved.primaryArticle.title,
          decision: review.decision
        },
        level: "success"
      });
    }

    const finishedAt = new Date();
    await TrendRssNewsConfig.findOneAndUpdate(
      { userId: input.userId },
      {
        status: config.autoRunEnabled ? "waiting" : "idle",
        lastRunAt: finishedAt,
        nextRunAt: config.autoRunEnabled ? addMinutes(finishedAt, config.intervalMinutes ?? 60) : null,
        lastError: null
      }
    );

    await logTrendStage({
      userId: input.userId,
      stage: "pipeline_complete",
      message: "Trend RSS pipeline completed",
      metadata: {
        source: input.source,
        trackedPages: facebookResult.trackedPages,
        ingestedPosts: facebookResult.ingestedPosts,
        rssSources: rssResult.sourceCount,
        storedArticles: rssResult.storedArticles,
        clusterCount: clusterResult.clusterCount,
        draftsCreated
      },
      level: "success"
    });

    return {
      started: true,
      trackedPages: facebookResult.trackedPages,
      ingestedPosts: facebookResult.ingestedPosts,
      rssSources: rssResult.sourceCount,
      storedArticles: rssResult.storedArticles,
      clusterCount: clusterResult.clusterCount,
      draftsCreated
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trend RSS pipeline failed";
    await TrendRssNewsConfig.findOneAndUpdate(
      { userId: input.userId },
      { status: "failed", lastError: message }
    );
    await logTrendStage({
      userId: input.userId,
      stage: "pipeline_failed",
      message,
      metadata: { source: input.source },
      level: "error"
    });
    throw error;
  }
}

export async function processDueTrendRssNewsModes() {
  await connectDb();
  const dueConfigs = (await TrendRssNewsConfig.find({
    enabled: true,
    autoRunEnabled: true,
    nextRunAt: { $lte: new Date() }
  })
    .select({ userId: 1 })
    .lean()) as unknown as Array<{ userId: string }>;

  let processed = 0;
  for (const config of dueConfigs) {
    await runTrendRssPipeline({
      userId: String(config.userId),
      source: "schedule"
    });
    processed += 1;
  }

  return processed;
}
