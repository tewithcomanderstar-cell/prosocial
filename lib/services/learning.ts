import { generateOptimizationSuggestions } from "@/lib/services/ai";
import { Post } from "@/models/Post";
import { PostMetric } from "@/models/PostMetric";

export async function getLearningInsights(userId: string) {
  const [posts, metrics] = await Promise.all([
    Post.find({ userId }).sort({ updatedAt: -1 }).limit(20).lean(),
    PostMetric.find({ userId }).sort({ publishedAt: -1 }).limit(50).lean()
  ]);

  const topMetric = metrics.reduce<typeof metrics[number] | null>((best, current) => {
    if (!best || (current.engagementScore ?? 0) > (best.engagementScore ?? 0)) {
      return current;
    }
    return best;
  }, null);

  const lowMetric = metrics.reduce<typeof metrics[number] | null>((worst, current) => {
    if (!worst || (current.engagementScore ?? 0) < (worst.engagementScore ?? 0)) {
      return current;
    }
    return worst;
  }, null);

  const notes = [
    topMetric ? `Best score: ${topMetric.engagementScore ?? 0} on page ${topMetric.pageId ?? "unknown"}.` : "No high-performing post yet.",
    lowMetric ? `Lowest score: ${lowMetric.engagementScore ?? 0} on page ${lowMetric.pageId ?? "unknown"}.` : "No low-performing post yet.",
    `Tracked posts: ${posts.length}`
  ].join(" ");

  let aiSuggestion = null as Awaited<ReturnType<typeof generateOptimizationSuggestions>> | null;
  if (posts[0]) {
    try {
      aiSuggestion = await generateOptimizationSuggestions({
        caption: posts[0].content,
        performanceNotes: notes,
        goal: "Improve future auto-post performance and identify better posting windows."
      });
    } catch {
      aiSuggestion = null;
    }
  }

  return {
    notes,
    topMetric,
    lowMetric,
    aiSuggestion
  };
}
