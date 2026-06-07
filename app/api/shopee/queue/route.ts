import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { AiGeneratedPost } from "@/models/AiGeneratedPost";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { Post } from "@/models/Post";
import { ShopeeProduct } from "@/models/ShopeeProduct";
import { isValidObjectId } from "mongoose";

function serializeQueueRouteError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      json: JSON.stringify(error, Object.getOwnPropertyNames(error))
    };
  }

  try {
    return {
      name: typeof error,
      message: String(error),
      stack: undefined,
      json: JSON.stringify(error)
    };
  } catch {
    return {
      name: typeof error,
      message: String(error),
      stack: undefined,
      json: "[unserializable_error]"
    };
  }
}

function safeObjectIdStrings(values: unknown[]) {
  const normalized = [...new Set(values.filter(Boolean).map(String))];
  return {
    valid: normalized.filter((value) => isValidObjectId(value)),
    invalid: normalized.filter((value) => !isValidObjectId(value))
  };
}

function logQueueRoute(step: string, metadata: Record<string, unknown> = {}) {
  console.info(`[${step}]`, {
    route: "/api/shopee/queue",
    timestamp: new Date().toISOString(),
    ...metadata
  });
}

export async function GET() {
  const routeStartedAt = Date.now();
  logQueueRoute("QUEUE_ROUTE_STARTED", { method: "GET" });
  let userId = "";
  try {
    userId = await requireAuth();
    logQueueRoute("QUEUE_ROUTE_INPUT", {
      userId,
      authenticated: true
    });

    const queue = await FacebookPostQueue.find({ userId })
      .sort({ scheduledAt: 1 })
      .limit(100)
      .lean();
    logQueueRoute("QUEUE_ROUTE_INPUT", {
      userId,
      queueCount: queue.length,
      queueIds: queue.slice(0, 20).map((item) => String(item._id)),
      statuses: queue.reduce<Record<string, number>>((acc, item) => {
        const status = String(item.status ?? "unknown");
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {})
    });

    const productIds = [...new Set(queue.map((item) => item.productId).filter(Boolean))];
    const aiPostIds = safeObjectIdStrings(queue.map((item) => item.aiGeneratedPostId));
    const postIds = safeObjectIdStrings(queue.map((item) => item.postId));
    if (aiPostIds.invalid.length || postIds.invalid.length) {
      logQueueRoute("QUEUE_ROUTE_INPUT", {
        userId,
        invalidAiGeneratedPostIds: aiPostIds.invalid,
        invalidPostIds: postIds.invalid,
        reason: "Invalid ObjectId values were filtered before Mongo _id lookup"
      });
    }

    const [products, aiPosts, posts] = await Promise.all([
      ShopeeProduct.find({ userId, productId: { $in: productIds } })
        .select("productId productName productPrice discountPrice discountPercent productImageUrl productImageUrls category rating salesCount reviewCount shopName")
        .lean(),
      aiPostIds.valid.length
        ? AiGeneratedPost.find({ userId, _id: { $in: aiPostIds.valid } })
        .select("caption affiliateLink generationMetaJson generatedImageUrl status")
            .lean()
        : Promise.resolve([]),
      postIds.valid.length
        ? Post.find({ userId, _id: { $in: postIds.valid } })
        .select("content imageUrls status")
            .lean()
        : Promise.resolve([])
    ]);
    logQueueRoute("QUEUE_ROUTE_INPUT", {
      userId,
      productIdsCount: productIds.length,
      aiPostIdsCount: aiPostIds.valid.length,
      postIdsCount: postIds.valid.length,
      productsFound: products.length,
      aiPostsFound: aiPosts.length,
      postsFound: posts.length
    });

    const productMap = new Map(products.map((product) => [String(product.productId), product]));
    const aiPostMap = new Map(aiPosts.map((post) => [String(post._id), post]));
    const postMap = new Map(posts.map((post) => [String(post._id), post]));

    const response = {
      queue: queue.map((item) => ({
        _id: String(item._id),
        pageId: item.pageId,
        postId: item.postId ? String(item.postId) : null,
        productId: item.productId,
        affiliateLink: item.affiliateLink,
        product: productMap.get(String(item.productId)) ?? null,
        preview: (() => {
          const aiPost = item.aiGeneratedPostId ? (aiPostMap.get(String(item.aiGeneratedPostId)) as any) : null;
          const post = item.postId ? (postMap.get(String(item.postId)) as any) : null;
          const aiImageUrls = Array.isArray(aiPost?.generationMetaJson?.generatedImageUrls)
            ? aiPost.generationMetaJson.generatedImageUrls
            : [];
          const postImageUrls = Array.isArray(post?.imageUrls) ? post.imageUrls : [];
          const imageUrls = aiImageUrls.length ? aiImageUrls : postImageUrls;

          return {
            aiGeneratedPostId: item.aiGeneratedPostId ? String(item.aiGeneratedPostId) : null,
            caption: aiPost?.caption ?? post?.content ?? "",
            affiliateLink: aiPost?.affiliateLink ?? item.affiliateLink,
            imageUrls,
            imageCount: imageUrls.length,
            status: aiPost?.status ?? post?.status ?? null
          };
        })(),
        scheduledAt: item.scheduledAt,
        status: item.status,
        failureReason: item.failureReason ?? null,
        errorCode: item.errorCode ?? null
      })),
      count: queue.length
    };
    logQueueRoute("QUEUE_ROUTE_COMPLETED", {
      userId,
      count: queue.length,
      durationMs: Date.now() - routeStartedAt
    });
    return jsonOk(response);
  } catch (error) {
    const serialized = serializeQueueRouteError(error);
    console.error("[QUEUE_ROUTE_ERROR]", {
      route: "/api/shopee/queue",
      userId: userId || undefined,
      durationMs: Date.now() - routeStartedAt,
      errorMessage: serialized.message,
      errorStack: serialized.stack,
      errorJson: serialized.json
    });
    const normalized = normalizeRouteError(error, "Unable to load Shopee affiliate queue");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
