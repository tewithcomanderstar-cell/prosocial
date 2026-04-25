import { fetchWithRetry } from "@/lib/services/http";

type FacebookPage = {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  picture?: {
    data?: {
      url?: string;
    };
  };
};

type FacebookGraphErrorPayload = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
};

type FacebookGraphPaging = {
  next?: string;
};

type FacebookCommentNode = {
  id?: string;
  message?: string;
  created_time?: string;
  parent?: {
    id?: string;
  };
  from?: {
    id?: string;
    name?: string;
  };
};

type FacebookPostNode = {
  id?: string;
  updated_time?: string;
  comments?: {
    summary?: {
      total_count?: number;
    };
  };
};

type FacebookPicturePayload = {
  data?: {
    url?: string;
  };
};

type FacebookPagePictureFieldPayload = {
  picture?: {
    data?: {
      url?: string;
    };
  };
};

export class FacebookPublishError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "token_expired"
      | "permission_denied"
      | "media_invalid"
      | "rate_limited"
      | "provider_transient"
      | "provider_unknown",
    public readonly retryable: boolean,
    public readonly details?: FacebookGraphErrorPayload["error"]
  ) {
    super(message);
    this.name = "FacebookPublishError";
  }
}

export class FacebookOAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "missing_config"
      | "oauth_exchange_failed"
      | "unsupported_permission"
      | "permission_denied"
      | "invalid_redirect"
      | "graph_request_failed" = "oauth_exchange_failed",
    public readonly details?: FacebookGraphErrorPayload["error"]
  ) {
    super(message);
    this.name = "FacebookOAuthError";
  }
}

export function getFacebookOAuthUrl() {
  if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_REDIRECT_URI) {
    throw new FacebookOAuthError("Facebook OAuth is not configured.", "missing_config");
  }

  const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  url.searchParams.set("client_id", process.env.FACEBOOK_APP_ID ?? "");
  url.searchParams.set("redirect_uri", process.env.FACEBOOK_REDIRECT_URI ?? "");
  url.searchParams.set(
    "scope",
    process.env.FACEBOOK_PAGE_CONNECT_SCOPE ??
      "pages_show_list,pages_manage_metadata,pages_read_engagement,pages_manage_engagement"
  );
  url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}

function classifyFacebookError(payload: FacebookGraphErrorPayload, fallback: string) {
  const message = payload.error?.message ?? fallback;
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("redirect_uri") || lowerMessage.includes("url blocked")) {
    return new FacebookOAuthError(message, "invalid_redirect", payload.error);
  }

  if (
    lowerMessage.includes("supported permission") ||
    (lowerMessage.includes("permission") && lowerMessage.includes("supported"))
  ) {
    return new FacebookOAuthError(message, "unsupported_permission", payload.error);
  }

  if (
    lowerMessage.includes("not authorized") ||
    lowerMessage.includes("permission denied") ||
    lowerMessage.includes("developer") ||
    lowerMessage.includes("tester") ||
    lowerMessage.includes("admin")
  ) {
    return new FacebookOAuthError(message, "permission_denied", payload.error);
  }

  return new FacebookOAuthError(message, "oauth_exchange_failed", payload.error);
}

function classifyFacebookPublishError(payload: FacebookGraphErrorPayload, fallback: string) {
  const message = payload.error?.message ?? fallback;
  const code = payload.error?.code;
  const subcode = payload.error?.error_subcode;
  const normalized = message.toLowerCase();

  if (code === 190 || normalized.includes("session has expired") || normalized.includes("token")) {
    return new FacebookPublishError(message, "token_expired", false, payload.error);
  }

  if (
    code === 10 ||
    code === 200 ||
    normalized.includes("permission") ||
    normalized.includes("not authorized")
  ) {
    return new FacebookPublishError(message, "permission_denied", false, payload.error);
  }

  if (
    code === 324 ||
    normalized.includes("media") ||
    normalized.includes("image") ||
    normalized.includes("photo")
  ) {
    return new FacebookPublishError(message, "media_invalid", false, payload.error);
  }

  if (code === 4 || code === 17 || code === 32 || code === 613 || normalized.includes("rate limit")) {
    return new FacebookPublishError(message, "rate_limited", true, payload.error);
  }

  if (subcode === 1363030 || normalized.includes("temporarily unavailable") || normalized.includes("try again")) {
    return new FacebookPublishError(message, "provider_transient", true, payload.error);
  }

  return new FacebookPublishError(message, "provider_unknown", true, payload.error);
}

export async function exchangeFacebookCode(code: string) {
  const url = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  url.searchParams.set("client_id", process.env.FACEBOOK_APP_ID ?? "");
  url.searchParams.set("client_secret", process.env.FACEBOOK_APP_SECRET ?? "");
  url.searchParams.set("redirect_uri", process.env.FACEBOOK_REDIRECT_URI ?? "");
  url.searchParams.set("code", code);

  const response = await fetchWithRetry(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookError(payload, "Failed to exchange Facebook code");
  }

  return response.json() as Promise<{ access_token: string; expires_in?: number }>;
}

export async function fetchFacebookPages(userAccessToken: string) {
  const url = new URL("https://graph.facebook.com/v21.0/me/accounts");
  url.searchParams.set("fields", "id,name,access_token,category,picture.type(large){url}");
  url.searchParams.set("access_token", userAccessToken);

  const response = await fetchWithRetry(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookError(payload, "Failed to fetch Facebook pages");
  }

  const payload = (await response.json()) as { data: FacebookPage[] };
  return payload.data.map((page) => ({
    pageId: page.id,
    name: page.name,
    pageAccessToken: page.access_token,
    category: page.category,
    profilePictureUrl: page.picture?.data?.url ?? null,
    profilePictureFetchedAt: page.picture?.data?.url ? new Date() : null
  }));
}

export async function subscribePageToWebhook(pageId: string, pageAccessToken: string) {
  const body = new URLSearchParams({
    subscribed_fields: "feed",
    access_token: pageAccessToken
  });

  const response = await fetchWithRetry(`https://graph.facebook.com/v21.0/${pageId}/subscribed_apps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookError(payload, "Failed to subscribe Facebook Page to webhooks");
  }

  return response.json() as Promise<{ success?: boolean }>;
}

export async function fetchFacebookPageProfilePictureUrl(params: {
  pageId: string;
  pageAccessToken: string;
}) {
  try {
    const pageUrl = new URL(`https://graph.facebook.com/v21.0/${params.pageId}`);
    pageUrl.searchParams.set("fields", "picture.type(large){url}");
    pageUrl.searchParams.set("access_token", params.pageAccessToken);

    const pageResponse = await fetchWithRetry(pageUrl.toString(), { cache: "no-store" });
    if (pageResponse.ok) {
      const payload = (await pageResponse.json()) as FacebookPagePictureFieldPayload;
      const resolvedUrl = payload.picture?.data?.url;
      if (resolvedUrl) {
        return resolvedUrl;
      }
    }
  } catch {}

  const pictureUrl = new URL(`https://graph.facebook.com/v21.0/${params.pageId}/picture`);
  pictureUrl.searchParams.set("redirect", "false");
  pictureUrl.searchParams.set("type", "large");
  pictureUrl.searchParams.set("access_token", params.pageAccessToken);

  const pictureResponse = await fetchWithRetry(pictureUrl.toString(), { cache: "no-store" });
  if (!pictureResponse.ok) {
    const payload = (await pictureResponse.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookPublishError(payload, "Failed to fetch Facebook page profile image URL");
  }

  const picturePayload = (await pictureResponse.json()) as FacebookPicturePayload;
  const resolvedUrl = picturePayload.data?.url;
  if (!resolvedUrl) {
    throw new FacebookPublishError("Facebook page profile image URL is missing", "provider_unknown", true);
  }

  return resolvedUrl;
}

export async function downloadRemoteImageBinary(url: string) {
  const imageResponse = await fetchWithRetry(url, { cache: "no-store" });
  if (!imageResponse.ok) {
    throw new FacebookPublishError("Failed to download remote image", "provider_unknown", true);
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  const mimeType = imageResponse.headers.get("content-type") || "image/png";

  return {
    bytes: arrayBuffer,
    mimeType
  };
}

export async function fetchFacebookPageProfileImage(params: {
  pageId: string;
  pageAccessToken: string;
  cachedUrl?: string | null;
}) {
  if (params.cachedUrl) {
    try {
      return await downloadRemoteImageBinary(params.cachedUrl);
    } catch {}
  }

  try {
    const resolvedUrl = await fetchFacebookPageProfilePictureUrl(params);
    return await downloadRemoteImageBinary(resolvedUrl);
  } catch {
    const fallbackUrl = new URL(`https://graph.facebook.com/v21.0/${params.pageId}/picture`);
    fallbackUrl.searchParams.set("type", "large");
    fallbackUrl.searchParams.set("access_token", params.pageAccessToken);
    return downloadRemoteImageBinary(fallbackUrl.toString());
  }
}

async function uploadPhotoByUrl(pageId: string, pageAccessToken: string, url: string) {
  const body = new URLSearchParams({
    url,
    published: "false",
    access_token: pageAccessToken
  });

  const response = await fetchWithRetry(`https://graph.facebook.com/v21.0/${pageId}/photos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookPublishError(payload, "Failed to upload Facebook photo");
  }

  return response.json() as Promise<{ id: string }>;
}

async function uploadPhotoByBuffer(
  pageId: string,
  pageAccessToken: string,
  fileName: string,
  bytes: ArrayBuffer,
  mimeType: string
) {
  const formData = new FormData();
  formData.set("published", "false");
  formData.set("access_token", pageAccessToken);
  formData.set("source", new Blob([bytes], { type: mimeType }), fileName);

  const response = await fetchWithRetry(`https://graph.facebook.com/v21.0/${pageId}/photos`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookPublishError(payload, "Failed to upload Facebook photo binary");
  }

  return response.json() as Promise<{ id: string }>;
}

export async function publishPostToFacebook(params: {
  pageId: string;
  pageAccessToken: string;
  message: string;
  images: Array<
    | { kind: "url"; value: string }
    | { kind: "binary"; fileName: string; bytes: ArrayBuffer; mimeType: string }
  >;
}) {
  const attachedMedia = [];

  for (const image of params.images) {
    const uploaded =
      image.kind === "url"
        ? await uploadPhotoByUrl(params.pageId, params.pageAccessToken, image.value)
        : await uploadPhotoByBuffer(
            params.pageId,
            params.pageAccessToken,
            image.fileName,
            image.bytes,
            image.mimeType
          );
    attachedMedia.push({ media_fbid: uploaded.id });
  }

  const body = new URLSearchParams({
    message: params.message,
    access_token: params.pageAccessToken
  });

  attachedMedia.forEach((media, index) => {
    body.append(`attached_media[${index}]`, JSON.stringify(media));
  });

  const response = await fetchWithRetry(`https://graph.facebook.com/v21.0/${params.pageId}/feed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookPublishError(payload, "Failed to publish Facebook post");
  }

  return response.json();
}

export async function replyToFacebookComment(params: {
  externalCommentId: string;
  pageAccessToken: string;
  message: string;
}) {
  const body = new URLSearchParams({
    message: params.message,
    access_token: params.pageAccessToken
  });

  const response = await fetchWithRetry(`https://graph.facebook.com/v21.0/${params.externalCommentId}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookPublishError(payload, "Failed to reply to Facebook comment");
  }

  return response.json() as Promise<{ id: string }>;
}

export async function fetchCommentsForFacebookPost(params: {
  postId: string;
  pageAccessToken: string;
  limit?: number;
}) {
  const maxItems = Math.max(1, Math.min(params.limit ?? 100, 500));
  const comments: Array<{
    externalCommentId: string;
    message: string;
    parentCommentId?: string;
    senderId?: string;
    authorName: string;
    createdAt?: string;
  }> = [];

  let nextUrl: string | null = (() => {
    const url = new URL(`https://graph.facebook.com/v21.0/${params.postId}/comments`);
    url.searchParams.set("fields", "id,message,created_time,parent{id},from{id,name}");
    url.searchParams.set("filter", "stream");
    url.searchParams.set("limit", String(Math.min(maxItems, 100)));
    url.searchParams.set("access_token", params.pageAccessToken);
    return url.toString();
  })();

  while (nextUrl && comments.length < maxItems) {
    const response = await fetchWithRetry(nextUrl, { cache: "no-store" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
      throw classifyFacebookPublishError(payload, "Failed to fetch Facebook comments");
    }

    const payload = (await response.json()) as {
      data?: FacebookCommentNode[];
      paging?: FacebookGraphPaging;
    };

    for (const item of payload.data ?? []) {
      if (!item.id || !item.message?.trim()) {
        continue;
      }

      comments.push({
        externalCommentId: item.id,
        message: item.message.trim(),
        parentCommentId: item.parent?.id,
        senderId: item.from?.id,
        authorName: item.from?.name?.trim() || "Facebook user",
        createdAt: item.created_time
      });

      if (comments.length >= maxItems) {
        break;
      }
    }

    nextUrl = payload.paging?.next ?? null;
  }

  return comments;
}

export async function fetchRecentFacebookPostsWithComments(params: {
  pageId: string;
  pageAccessToken: string;
  limit?: number;
}) {
  const maxItems = Math.max(1, Math.min(params.limit ?? 25, 100));
  const url = new URL(`https://graph.facebook.com/v21.0/${params.pageId}/posts`);
  url.searchParams.set("fields", "id,updated_time,comments.limit(1).summary(true)");
  url.searchParams.set("limit", String(maxItems));
  url.searchParams.set("access_token", params.pageAccessToken);

  const response = await fetchWithRetry(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as FacebookGraphErrorPayload;
    throw classifyFacebookPublishError(payload, "Failed to fetch Facebook page posts");
  }

  const payload = (await response.json()) as { data?: FacebookPostNode[] };
  return (payload.data ?? [])
    .filter((item) => (item.comments?.summary?.total_count ?? 0) > 0 && item.id)
    .map((item) => ({
      postId: item.id as string,
      updatedAt: item.updated_time,
      commentCount: item.comments?.summary?.total_count ?? 0
    }));
}
