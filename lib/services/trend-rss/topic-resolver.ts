import { RssArticle } from "@/models/RssArticle";
import { TrendArticleResolution } from "@/models/TrendArticleResolution";
import { TrendTopicCluster } from "@/models/TrendTopicCluster";

function scoreArticleMatch(cluster: { relatedEntities?: string[] }, article: {
  title: string;
  summary?: string;
  fullContent?: string;
  entities?: string[];
  publishedAt?: Date | null;
}) {
  const clusterTerms = new Set((cluster.relatedEntities ?? []).map((term) => term.toLowerCase()));
  const haystack = `${article.title} ${article.summary ?? ""} ${article.fullContent ?? ""}`.toLowerCase();
  let overlap = 0;
  for (const term of clusterTerms) {
    if (haystack.includes(term)) overlap += 1;
  }
  const recencyBonus = article.publishedAt
    ? Math.max(0, 24 - (Date.now() - new Date(article.publishedAt).getTime()) / (60 * 60 * 1000))
    : 0;
  return overlap * 4 + recencyBonus + (article.entities?.length ?? 0) * 0.2;
}

export async function resolveTopicClusterToArticle(userId: string, clusterId: string) {
  const cluster = await TrendTopicCluster.findOne({ _id: clusterId, userId }).lean();
  if (!cluster) {
    throw new Error("Trend topic cluster not found");
  }

  const articles = await RssArticle.find({
    userId,
    fetchedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
  })
    .sort({ publishedAt: -1, fetchedAt: -1 })
    .limit(150)
    .lean();

  const ranked = articles
    .map((article) => ({ article, score: scoreArticleMatch(cluster as any, article as any) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;

  const primary = ranked[0];
  const supporting = ranked.slice(1, 4);

  const resolution = await TrendArticleResolution.findOneAndUpdate(
    { userId, topicClusterId: clusterId },
    {
      userId,
      topicClusterId: clusterId,
      primaryArticleId: primary.article._id,
      supportingArticleIds: supporting.map((item) => item.article._id),
      confidenceScore: Number(Math.min(1, primary.score / 20).toFixed(2)),
      resolutionNotes: `Matched by entity overlap and recency from ${ranked.length} candidate articles.`
    },
    { upsert: true, new: true }
  );

  await TrendTopicCluster.findByIdAndUpdate(clusterId, { status: "resolved" });

  return {
    cluster,
    resolution,
    primaryArticle: primary.article,
    supportingArticles: supporting.map((item) => item.article)
  };
}
