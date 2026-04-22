import { FacebookConnection } from "@/models/FacebookConnection";
import { TrendTrackedPage } from "@/models/TrendTrackedPage";
import { TrendFacebookPost } from "@/models/TrendFacebookPost";
import { TrendFacebookPostSnapshot } from "@/models/TrendFacebookPostSnapshot";
import { fetchWithRetry } from "@/lib/services/http";

type GraphPost = {
  id?: string;
  message?: string;
  created_time?: string;
  shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  attachments?: {
    data?: Array<{ media?: { image?: { src?: string } }; url?: string }>;
  };
};

async function fetchPageFeed(pageId: string, pageAccessToken: string, limit = 10) {
  const url = new URL(`https://graph.facebook.com/v21.0/${pageId}/posts`);
  url.searchParams.set(
    "fields",
    "id,message,created_time,shares,reactions.limit(0).summary(true),comments.limit(0).summary(true),attachments{media,url}"
  );
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 25))));
  url.searchParams.set("access_token", pageAccessToken);

  const response = await fetchWithRetry(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to fetch Facebook source posts for page ${pageId}`);
  }

  const payload = (await response.json()) as { data?: GraphPost[] };
  return payload.data ?? [];
}

export async function ingestTrackedFacebookTrendPosts(userId: string) {
  const trackedPages = (await TrendTrackedPage.find({ userId, active: true }).lean()) as unknown as Array<{
    pageId: string;
    pageName: string;
  }>;
  const connection = (await FacebookConnection.findOne({ userId }).lean()) as
    | { pages?: Array<{ pageId: string; pageAccessToken: string; name?: string }> }
    | null;
  const connectedPages =
    ((connection?.pages ?? []) as Array<{ pageId: string; pageAccessToken: string; name?: string }>) ?? [];

  let ingestedPosts = 0;
  const pageSummaries: Array<Record<string, unknown>> = [];

  for (const trackedPage of trackedPages) {
    const connectedPage = connectedPages.find((page) => page.pageId === trackedPage.pageId);
    if (!connectedPage?.pageAccessToken) {
      pageSummaries.push({
        pageId: trackedPage.pageId,
        pageName: trackedPage.pageName,
        status: "skipped",
        reason: "page_not_connected"
      });
      continue;
    }

    const posts = await fetchPageFeed(trackedPage.pageId, connectedPage.pageAccessToken, 12);

    for (const post of posts) {
      if (!post.id) continue;
      const mediaUrls = (post.attachments?.data ?? [])
        .map((item) => item.media?.image?.src ?? item.url)
        .filter((item): item is string => Boolean(item));

      const saved = await TrendFacebookPost.findOneAndUpdate(
        {
          userId,
          pageId: trackedPage.pageId,
          externalPostId: post.id
        },
        {
          userId,
          pageId: trackedPage.pageId,
          externalPostId: post.id,
          message: post.message?.trim() ?? "",
          createdAtExternal: post.created_time ? new Date(post.created_time) : null,
          reactionsCount: post.reactions?.summary?.total_count ?? 0,
          commentsCount: post.comments?.summary?.total_count ?? 0,
          sharesCount: post.shares?.count ?? 0,
          mediaUrls,
          rawPayload: post,
          fetchedAt: new Date()
        },
        { upsert: true, new: true }
      );

      await TrendFacebookPostSnapshot.create({
        trendFacebookPostId: saved._id,
        reactionsCount: post.reactions?.summary?.total_count ?? 0,
        commentsCount: post.comments?.summary?.total_count ?? 0,
        sharesCount: post.shares?.count ?? 0,
        snapshotAt: new Date()
      });

      ingestedPosts += 1;
    }

    pageSummaries.push({
      pageId: trackedPage.pageId,
      pageName: trackedPage.pageName,
      status: "ok",
      postCount: posts.length
    });
  }

  return {
    trackedPages: trackedPages.length,
    ingestedPosts,
    pageSummaries
  };
}
