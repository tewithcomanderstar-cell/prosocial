import { jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { TrendTopicCluster } from "@/models/TrendTopicCluster";
import { TrendArticleResolution } from "@/models/TrendArticleResolution";
import { RssArticle } from "@/models/RssArticle";
import { TrendFacebookPost } from "@/models/TrendFacebookPost";
import { ContentItem } from "@/models/ContentItem";

export async function GET() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const clusters = await TrendTopicCluster.find({ userId }).sort({ detectedAt: -1 }).limit(25).lean();
    const resolutions = await TrendArticleResolution.find({
      userId,
      topicClusterId: { $in: clusters.map((cluster) => cluster._id) }
    }).lean();

    const articleIds = resolutions.flatMap((item) => [
      item.primaryArticleId,
      ...(item.supportingArticleIds ?? [])
    ]);
    const articles = await RssArticle.find({ _id: { $in: articleIds } }).lean();

    const clusterIds = clusters.map((cluster) => String(cluster._id));
    const drafts = await ContentItem.find({
      mode: "trend_rss_news_mode",
      "sourceTraceJson.clusterId": { $in: clusterIds }
    })
      .sort({ createdAt: -1 })
      .lean();

    const sourcePostIds = clusters.flatMap((cluster) => cluster.sourcePostIds ?? []);
    const sourcePosts = await TrendFacebookPost.find({ _id: { $in: sourcePostIds } }).lean();

    return jsonOk({
      clusters: clusters.map((cluster) => {
        const resolution = resolutions.find((item) => String(item.topicClusterId) === String(cluster._id)) ?? null;
        const primaryArticle = resolution
          ? articles.find((article) => String(article._id) === String(resolution.primaryArticleId)) ?? null
          : null;
        const draft = drafts.find(
          (item) => String((item.sourceTraceJson as Record<string, unknown> | undefined)?.clusterId ?? "") === String(cluster._id)
        ) ?? null;
        const sourceImages = sourcePosts
          .filter((post) =>
            (cluster.sourcePostIds ?? []).some((id: unknown) => String(id) === String(post._id))
          )
          .flatMap((post) => post.mediaUrls ?? [])
          .filter(Boolean)
          .slice(0, 4);

        const imagePayload = (draft?.imagePayloadJson ?? {}) as Record<string, unknown>;
        const payload = (draft?.platformPayloadJson ?? {}) as Record<string, unknown>;

        return {
          ...cluster,
          resolution: resolution
            ? {
                confidenceScore: resolution.confidenceScore,
                resolutionNotes: resolution.resolutionNotes,
                primaryArticle: primaryArticle
                  ? {
                      title: primaryArticle.title,
                      url: primaryArticle.url,
                      summary: primaryArticle.summary,
                      publishedAt: primaryArticle.publishedAt
                    }
                  : null
              }
            : null,
          preview: draft
            ? {
                draftId: String(draft._id),
                status: draft.status,
                title: draft.title,
                selectedHeadline: payload.selectedHeadline ?? draft.title,
                selectedCaption: payload.selectedCaption ?? draft.bodyText,
                generatedBody: payload.generatedBody ?? "",
                imageHeadline: imagePayload.headlineText ?? "",
                imageSubheadline: imagePayload.subheadlineText ?? "",
                sourceImages
              }
            : null
        };
      })
    });
  } catch (error) {
    return handleRoleError(error);
  }
}
