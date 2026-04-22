import { TrendFacebookPost } from "@/models/TrendFacebookPost";
import { TrendFacebookPostSnapshot } from "@/models/TrendFacebookPostSnapshot";
import { TrendTopicCluster } from "@/models/TrendTopicCluster";

const STOPWORDS = new Set(["???", "???", "???", "??", "???", "???", "????", "????", "???", "????", "the", "for", "with", "this", "that"]);

function tokenize(text: string) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((token) => !STOPWORDS.has(token));
}

function topTokens(text: string) {
  return [...new Set(tokenize(text))].slice(0, 6);
}

function scoreVelocity(current: { reactionsCount: number; commentsCount: number; sharesCount: number }, previous?: {
  reactionsCount: number;
  commentsCount: number;
  sharesCount: number;
}) {
  const reactionDelta = current.reactionsCount - (previous?.reactionsCount ?? 0);
  const commentDelta = current.commentsCount - (previous?.commentsCount ?? 0);
  const shareDelta = current.sharesCount - (previous?.sharesCount ?? 0);
  return reactionDelta * 0.4 + commentDelta * 1.3 + shareDelta * 1.8 + current.commentsCount * 0.6;
}

export async function clusterTrendTopics(userId: string) {
  const posts = (await TrendFacebookPost.find({
    userId,
    fetchedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  })
    .sort({ fetchedAt: -1 })
    .lean()) as unknown as Array<{
    _id: unknown;
    message?: string;
    reactionsCount: number;
    commentsCount: number;
    sharesCount: number;
  }>;

  const clusters = new Map<string, {
    label: string;
    summary: string;
    sourcePostIds: string[];
    relatedEntities: string[];
    trendScore: number;
    emotionType: "alarm" | "hope" | "conflict" | "human_interest" | "neutral";
  }>();

  for (const post of posts) {
    const message = post.message?.trim();
    if (!message) continue;
    const tokens = topTokens(message);
    if (!tokens.length) continue;
    const key = tokens.slice(0, 3).join("|");
    const snapshots = await TrendFacebookPostSnapshot.find({ trendFacebookPostId: post._id })
      .sort({ snapshotAt: -1 })
      .limit(2)
      .lean();
    const velocity = scoreVelocity(post, snapshots[1] as any);
    const existing = clusters.get(key);

    if (existing) {
      existing.sourcePostIds.push(String(post._id));
      existing.relatedEntities = [...new Set([...existing.relatedEntities, ...tokens])].slice(0, 10);
      existing.trendScore += velocity;
      continue;
    }

    const emotionType =
      message.includes("????") || message.includes("???????")
        ? "alarm"
        : message.includes("?????????") || message.includes("????????")
          ? "human_interest"
          : message.includes("????") || message.includes("???")
            ? "conflict"
            : "neutral";

    clusters.set(key, {
      label: tokens.slice(0, 2).join(" / "),
      summary: message.length > 220 ? `${message.slice(0, 217)}...` : message,
      sourcePostIds: [String(post._id)],
      relatedEntities: tokens,
      trendScore: velocity,
      emotionType
    });
  }

  const savedClusters = [];
  for (const cluster of clusters.values()) {
    const hotLevel = cluster.trendScore >= 30 ? "surging" : cluster.trendScore >= 12 ? "hot" : "warm";
    const saved = await TrendTopicCluster.findOneAndUpdate(
      {
        userId,
        label: cluster.label,
        detectedAt: { $gte: new Date(Date.now() - 12 * 60 * 60 * 1000) }
      },
      {
        userId,
        label: cluster.label,
        summary: cluster.summary,
        emotionType: cluster.emotionType,
        trendScore: Number(cluster.trendScore.toFixed(2)),
        hotLevel,
        status: "detected",
        sourcePostIds: cluster.sourcePostIds,
        relatedEntities: cluster.relatedEntities,
        detectedAt: new Date()
      },
      { upsert: true, new: true }
    );
    savedClusters.push(saved);
  }

  return {
    clusterCount: savedClusters.length,
    clusters: savedClusters
  };
}
