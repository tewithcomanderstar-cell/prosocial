import { getAnalyticsOverview } from "@/lib/services/analytics";
import { getLearningInsights } from "@/lib/services/learning";

export async function getSmartRecommendations(userId: string) {
  const [analytics, learning] = await Promise.all([
    getAnalyticsOverview(userId),
    getLearningInsights(userId)
  ]);

  return {
    bestTimeToPost: analytics.bestHour,
    bestPost: analytics.bestPost,
    learning,
    suggestions: [
      analytics.bestHour ? `Try posting around ${analytics.bestHour.hour}:00 local time more often.` : "Track more published posts to discover the best posting window.",
      learning.aiSuggestion?.improvedCaption ?? "Enable more analytics data to unlock caption improvement suggestions.",
      analytics.averageEngagement > 0 ? `Average engagement score is ${analytics.averageEngagement}. Use the best-performing caption style as a template.` : "No engagement score yet. Publish more posts to unlock smarter recommendations."
    ]
  };
}
