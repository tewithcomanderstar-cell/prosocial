import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";

export async function GET() {
  try {
    const userId = await requireAuth();
    const queue = await FacebookPostQueue.find({ userId })
      .sort({ scheduledAt: 1 })
      .limit(100)
      .lean();

    return jsonOk({
      queue: queue.map((item) => ({
        _id: String(item._id),
        pageId: item.pageId,
        postId: item.postId ? String(item.postId) : null,
        productId: item.productId,
        affiliateLink: item.affiliateLink,
        scheduledAt: item.scheduledAt,
        status: item.status,
        failureReason: item.failureReason ?? null,
        errorCode: item.errorCode ?? null
      })),
      count: queue.length
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to load Shopee affiliate queue");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
