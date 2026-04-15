import { fetchWithRetry } from "@/lib/services/http";

type FacebookPage = {
  id: string;
  name: string;
  access_token: string;
  category?: string;
};

type FacebookGraphErrorPayload = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
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
    category: page.category
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
