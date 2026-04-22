import { jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { TrendTopicCluster } from "@/models/TrendTopicCluster";
import { TrendArticleResolution } from "@/models/TrendArticleResolution";

export async function GET() {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const clusters = await TrendTopicCluster.find({ userId }).sort({ detectedAt: -1 }).limit(25).lean();
    const resolutions = await TrendArticleResolution.find({
      userId,
      topicClusterId: { $in: clusters.map((cluster) => cluster._id) }
    }).lean();

    return jsonOk({
      clusters: clusters.map((cluster) => ({
        ...cluster,
        resolution: resolutions.find((item) => String(item.topicClusterId) === String(cluster._id)) ?? null
      }))
    });
  } catch (error) {
    return handleRoleError(error);
  }
}
