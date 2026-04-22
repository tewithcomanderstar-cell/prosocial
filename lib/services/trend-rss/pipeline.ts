import { TrendRssNewsConfig } from "@/models/TrendRssNewsConfig";
import { TrendTopicCluster } from "@/models/TrendTopicCluster";
import { TrendArticleResolution } from "@/models/TrendArticleResolution";
import { TrendFacebookPost } from "@/models/TrendFacebookPost";
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
import { createTrendRssAutoPost, createTrendRssDraft } from "@/lib/services/trend-rss/draft-integration";
import { logTrendStage } from "@/lib/services/trend-rss/execution-log";

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function normalizeInterval(value?: number | null) {
  return value === 30 || value === 60 || value === 120 ? value : 60;
}

function shouldRunWindow(nextAt?: Date | null, force?: boolean) {
  if (force) return true;
  if (!nextAt) return true;
  return nextAt.getTime() <= Date.now();
}

export async function runTrendRssPipeline(input: {
  userId: string;
  source: "manual" | "schedule";
  force?: boolean;
}) {
  await connectDb();
  const config = await TrendRssNewsConfig.findOne({ userId: input.userId });

  if (!config) {
    throw new Error("Trend news config not found");
  }

  if (!config.enabled && !input.force) {
    return { started: false, reason: "mode_disabled" };
  }

  const scanDue = config.autoRunEnabled ? shouldRunWindow(config.nextScanAt, input.force) : Boolean(input.force);
  const autoPostDue =
    config.autoPostEnabled && !config.safeDraftMode
      ? shouldRunWindow(config.nextAutoPostAt, input.force)
      : false;

  if (!scanDue && !autoPostDue) {
    return { started: false, reason: "nothing_due" };
  }

  await TrendRssNewsConfig.findOneAndUpdate(
    { userId: input.userId },
    { status: "running", lastError: null }
  );

  await logTrendStage({
    userId: input.userId,
    stage: "pipeline_start",
    message: "ระบบจับกระแสข่าวเริ่มทำงาน",
    metadata: { source: input.source, scanDue, autoPostDue }
  });

  try {
    let facebookResult = { trackedPages: 0, ingestedPosts: 0, pageSummaries: [] as Array<Record<string, unknown>> };
    let rssResult = { sourceCount: 0, storedArticles: 0 };
    let clusterResult = { clusterCount: 0 };

    if (scanDue) {
      facebookResult = await ingestTrackedFacebookTrendPosts(input.userId);
      rssResult = await ingestRssArticles(input.userId);
      clusterResult = await clusterTrendTopics(input.userId);
    }

    const hotClusters = await TrendTopicCluster.find({
      userId: input.userId,
      status: { $in: ["detected", "resolved"] },
      trendScore: { $gte: 4 }
    })
      .sort({ trendScore: -1, detectedAt: -1 })
      .limit(5)
      .lean();

    let draftsCreated = 0;
    let autoPostsQueued = 0;
    const autoPublishCandidates: Array<{
      headline: string;
      caption: string;
      body: string;
      imageUrls: string[];
      traceability: Record<string, unknown>;
      draftId: string;
      clusterId: string;
    }> = [];

    for (const cluster of hotClusters as Array<any>) {
      const resolved = await resolveTopicClusterToArticle(input.userId, String(cluster._id));
      if (!resolved) {
        await logTrendStage({
          userId: input.userId,
          topicClusterId: String(cluster._id),
          stage: "resolve_skipped",
          message: "ยังจับคู่เว็บข่าวที่เกี่ยวข้องกับประเด็นนี้ไม่ได้",
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
          message: "ระบบรีวิวมองว่าความเสี่ยงสูงเกินไป ยังไม่สร้างคอนเทนต์ข่าว",
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
      const sourcePostDocs = (await TrendFacebookPost.find({
        _id: { $in: sourcePosts }
      }).lean()) as unknown as Array<{ mediaUrls?: string[] }>;
      const sourceImages = [...new Set(sourcePostDocs.flatMap((post) => post.mediaUrls ?? []).filter(Boolean))].slice(0, 6);

      const imagePayload = buildTrendImagePayload({
        templateId: config.templateId,
        selectedImages: sourceImages,
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
        reviewStatus:
          review.decision === "approved_for_draft" && !config.safeDraftMode ? "draft" : "needs_review",
        sourceTraceabilityMetadata: {
          clusterId: String(cluster._id),
          clusterLabel: cluster.label,
          facebookPostIds: sourcePosts,
          articleIds: [
            String(resolved.primaryArticle._id),
            ...resolved.supportingArticles.map((article) => String(article._id))
          ],
          urls: [resolved.primaryArticle.url, ...resolved.supportingArticles.map((article) => article.url)],
          primaryArticleTitle: resolved.primaryArticle.title,
          primaryArticleUrl: resolved.primaryArticle.url
        }
      });

      draftsCreated += 1;

      const reviewDecision =
        review.decision === "approved_for_draft" && !config.safeDraftMode ? "generated" : "needs_review";
      await TrendTopicCluster.findByIdAndUpdate(cluster._id, { status: reviewDecision });

      await TrendRssNewsConfig.findOneAndUpdate({ userId: input.userId }, { lastDraftId: draft._id });

      await logTrendStage({
        userId: input.userId,
        topicClusterId: String(cluster._id),
        contentItemId: String(draft._id),
        stage: "draft_created",
        message: "สร้างดราฟต์ข่าวจากกระแสที่ตรวจจับได้แล้ว",
        metadata: {
          draftId: String(draft._id),
          headline: content.headlineVariants[0] ?? resolved.primaryArticle.title,
          decision: review.decision
        },
        level: "success"
      });

      if (config.autoPostEnabled && !config.safeDraftMode && review.decision === "approved_for_draft") {
        autoPublishCandidates.push({
          headline: content.headlineVariants[0] ?? resolved.primaryArticle.title,
          caption: content.captionVariants[0] ?? resolved.primaryArticle.summary ?? "",
          body: content.bodyDraft,
          imageUrls: sourceImages,
          traceability: {
            clusterId: String(cluster._id),
            draftId: String(draft._id),
            facebookPostIds: sourcePosts,
            articleIds: [
              String(resolved.primaryArticle._id),
              ...resolved.supportingArticles.map((article) => String(article._id))
            ],
            articleUrls: [resolved.primaryArticle.url, ...resolved.supportingArticles.map((article) => article.url)]
          },
          draftId: String(draft._id),
          clusterId: String(cluster._id)
        });
      }
    }

    if (autoPostDue && autoPublishCandidates.length > 0 && (config.destinationPageIds ?? []).length > 0) {
      const candidate = autoPublishCandidates[0];
      const created = await createTrendRssAutoPost({
        userId: input.userId,
        destinationPageIds: config.destinationPageIds ?? [],
        headline: candidate.headline,
        caption: candidate.caption,
        body: candidate.body,
        imageUrls: candidate.imageUrls,
        sourceTraceabilityMetadata: candidate.traceability
      });

      autoPostsQueued = created.queuedJobs;

      await logTrendStage({
        userId: input.userId,
        topicClusterId: candidate.clusterId,
        contentItemId: candidate.draftId,
        stage: "auto_post_queued",
        message: "ส่งคอนเทนต์ข่าวเข้า queue สำหรับโพสต์อัตโนมัติแล้ว",
        metadata: {
          postId: String(created.post._id),
          queuedJobs: created.queuedJobs
        },
        level: "success"
      });
    }

    const finishedAt = new Date();
    const nextScanAt =
      config.autoRunEnabled && config.enabled ? addMinutes(finishedAt, normalizeInterval(config.intervalMinutes)) : null;
    const nextAutoPostAt =
      config.autoPostEnabled && config.enabled
        ? addMinutes(finishedAt, normalizeInterval(config.autoPostIntervalMinutes))
        : null;

    await TrendRssNewsConfig.findOneAndUpdate(
      { userId: input.userId },
      {
        status: config.enabled ? "waiting" : "idle",
        lastRunAt: finishedAt,
        nextRunAt: nextScanAt,
        lastScanAt: scanDue ? finishedAt : config.lastScanAt,
        nextScanAt,
        lastAutoPostAt: autoPostsQueued > 0 ? finishedAt : config.lastAutoPostAt,
        nextAutoPostAt,
        lastError: null
      }
    );

    await logTrendStage({
      userId: input.userId,
      stage: "pipeline_complete",
      message: "ระบบจับกระแสข่าวทำงานเสร็จแล้ว",
      metadata: {
        source: input.source,
        trackedPages: facebookResult.trackedPages,
        ingestedPosts: facebookResult.ingestedPosts,
        rssSources: rssResult.sourceCount,
        storedArticles: rssResult.storedArticles,
        clusterCount: clusterResult.clusterCount,
        draftsCreated,
        autoPostsQueued
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
      draftsCreated,
      autoPostsQueued
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trend pipeline failed";
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
  const now = new Date();
  const dueConfigs = (await TrendRssNewsConfig.find({
    enabled: true,
    $or: [
      { autoRunEnabled: true, nextScanAt: { $lte: now } },
      { autoPostEnabled: true, safeDraftMode: false, nextAutoPostAt: { $lte: now } }
    ]
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
