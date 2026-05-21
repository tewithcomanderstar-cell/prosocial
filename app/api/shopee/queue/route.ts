import { jsonError, jsonOk, normalizeRouteError, requireAuth } from "@/lib/api";
import { AiGeneratedPost } from "@/models/AiGeneratedPost";
import { FacebookPostQueue } from "@/models/FacebookPostQueue";
import { Post } from "@/models/Post";
import { ShopeeProduct } from "@/models/ShopeeProduct";

export async function GET() {
  try {
    const userId = await requireAuth();
    const queue = await FacebookPostQueue.find({ userId })
      .sort({ scheduledAt: 1 })
      .limit(100)
      .lean();
    const productIds = [...new Set(queue.map((item) => item.productId).filter(Boolean))];
    const aiPostIds = [...new Set(queue.map((item) => item.aiGeneratedPostId).filter(Boolean).map(String))];
    const postIds = [...new Set(queue.map((item) => item.postId).filter(Boolean).map(String))];
    const [products, aiPosts, posts] = await Promise.all([
      ShopeeProduct.find({ userId, productId: { $in: productIds } })
        .select("productId productName productPrice discountPrice discountPercent productImageUrl productImageUrls category rating salesCount reviewCount shopName")
        .lean(),
      AiGeneratedPost.find({ userId, _id: { $in: aiPostIds } })
        .select("caption affiliateLink generationMetaJson generatedImageUrl status")
        .lean(),
      Post.find({ userId, _id: { $in: postIds } })
        .select("content imageUrls status")
        .lean()
    ]);
    const productMap = new Map(products.map((product) => [String(product.productId), product]));
    const aiPostMap = new Map(aiPosts.map((post) => [String(post._id), post]));
    const postMap = new Map(posts.map((post) => [String(post._id), post]));

    return jsonOk({
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
    });
  } catch (error) {
    const normalized = normalizeRouteError(error, "Unable to load Shopee affiliate queue");
    return jsonError(normalized.message, normalized.status, normalized.code);
  }
}
