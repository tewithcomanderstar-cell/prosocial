import { PostMetric } from "@/models/PostMetric";

export async function recordMetricSnapshot(params: {
  userId: string;
  postId: string;
  scheduleId?: string;
  pageId?: string;
  externalPostId?: string;
  publishedAt?: Date;
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
  source?: "sync" | "manual" | "estimated";
}) {
  const likes = params.likes ?? 0;
  const comments = params.comments ?? 0;
  const shares = params.shares ?? 0;
  const impressions = params.impressions ?? 0;
  const engagementScore = likes + comments * 2 + shares * 3 + impressions * 0.05;

  return PostMetric.create({
    userId: params.userId,
    postId: params.postId,
    scheduleId: params.scheduleId,
    pageId: params.pageId,
    externalPostId: params.externalPostId,
    publishedAt: params.publishedAt ?? new Date(),
    likes,
    comments,
    shares,
    impressions,
    engagementScore,
    source: params.source ?? "estimated"
  });
}

export async function getAnalyticsOverview(userId: string) {
  const metrics = await PostMetric.find({ userId }).sort({ publishedAt: -1 }).lean();
  const totalPosts = metrics.length;
  const totals = metrics.reduce(
    (acc, item) => {
      acc.likes += item.likes ?? 0;
      acc.comments += item.comments ?? 0;
      acc.shares += item.shares ?? 0;
      acc.impressions += item.impressions ?? 0;
      return acc;
    },
    { likes: 0, comments: 0, shares: 0, impressions: 0 }
  );

  const bestPost = metrics.reduce<typeof metrics[number] | null>((best, current) => {
    if (!best || (current.engagementScore ?? 0) > (best.engagementScore ?? 0)) {
      return current;
    }
    return best;
  }, null);

  const hourMap = new Map<number, { count: number; score: number }>();
  for (const item of metrics) {
    const hour = new Date(item.publishedAt).getHours();
    const current = hourMap.get(hour) ?? { count: 0, score: 0 };
    current.count += 1;
    current.score += item.engagementScore ?? 0;
    hourMap.set(hour, current);
  }

  let bestHour = null as null | { hour: number; averageScore: number };
  for (const [hour, value] of hourMap.entries()) {
    const averageScore = value.score / value.count;
    if (!bestHour || averageScore > bestHour.averageScore) {
      bestHour = { hour, averageScore };
    }
  }

  return {
    totalPosts,
    totals,
    averageEngagement: totalPosts ? Number(((totals.likes + totals.comments * 2 + totals.shares * 3) / totalPosts).toFixed(2)) : 0,
    bestPost,
    bestHour,
    recentMetrics: metrics.slice(0, 20)
  };
}
