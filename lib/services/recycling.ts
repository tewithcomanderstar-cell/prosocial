import { generateOptimizationSuggestions } from "@/lib/services/ai";
import { Post } from "@/models/Post";
import { PostMetric } from "@/models/PostMetric";
import { RecyclingRule } from "@/models/RecyclingRule";

type RecyclingRuleShape = {
  minAgeDays?: number | null;
  minimumEngagementScore?: number | null;
  rewriteWithAi?: boolean | null;
};

export async function getRecyclingSuggestions(userId: string) {
  const rule = (await RecyclingRule.findOne({ userId, active: true }).sort({ updatedAt: -1 }).lean()) as RecyclingRuleShape | null;
  const minAgeDays = rule?.minAgeDays ?? 7;
  const minimumEngagementScore = rule?.minimumEngagementScore ?? 5;
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

  const metrics = await PostMetric.find({ userId, publishedAt: { $lte: cutoff }, engagementScore: { $gte: minimumEngagementScore } })
    .sort({ engagementScore: -1 })
    .limit(5)
    .lean();

  const postIds = metrics.map((item) => item.postId);
  const posts = await Post.find({ _id: { $in: postIds } }).lean();
  const postMap = new Map(posts.map((post) => [String(post._id), post]));

  const suggestions = [] as Array<{
    postId: string;
    originalCaption: string;
    engagementScore: number;
    improvedCaption?: string;
    abTestIdeas?: string[];
  }>;

  for (const metric of metrics) {
    const post = postMap.get(String(metric.postId));
    if (!post) {
      continue;
    }

    let improvedCaption: string | undefined;
    let abTestIdeas: string[] | undefined;

    if (rule?.rewriteWithAi) {
      try {
        const ai = await generateOptimizationSuggestions({
          caption: post.content,
          performanceNotes: `Past engagement score: ${metric.engagementScore ?? 0}`,
          goal: "Rewrite this content for a smart repost while keeping the core message."
        });
        improvedCaption = ai.improvedCaption;
        abTestIdeas = ai.abTestIdeas;
      } catch {
        improvedCaption = undefined;
      }
    }

    suggestions.push({
      postId: String(post._id),
      originalCaption: post.content,
      engagementScore: metric.engagementScore ?? 0,
      improvedCaption,
      abTestIdeas
    });
  }

  return {
    rule,
    suggestions
  };
}
