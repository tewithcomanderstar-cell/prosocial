import { FallbackContent } from "@/models/FallbackContent";
import { ContentTemplate } from "@/models/ContentTemplate";
import { GeneratedVariant } from "@/lib/types";

export async function getFallbackVariants(userId: string | null, keyword: string) {
  if (!userId) {
    return [] as GeneratedVariant[];
  }

  const [fallbacks, templates] = await Promise.all([
    FallbackContent.find({ userId, keyword: { $regex: keyword, $options: "i" } }).sort({ priority: 1 }).limit(3).lean(),
    ContentTemplate.find({ userId, active: true, category: { $regex: keyword, $options: "i" } }).limit(2).lean()
  ]);

  const fallbackVariants = fallbacks.map((item) => ({
    caption: item.caption,
    hashtags: item.hashtags ?? []
  }));

  const templateVariants = templates.map((item) => ({
    caption: item.bodyTemplate.replace(/\{\{keyword\}\}/gi, keyword),
    hashtags: item.hashtagTemplate ?? []
  }));

  return [...fallbackVariants, ...templateVariants].slice(0, 5);
}
