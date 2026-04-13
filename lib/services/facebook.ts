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
  url.searchParams.set("scope", process.env.FACEBOOK_PAGE_CONNECT_SCOPE ?? "pages_show_list");
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
    throw new Error("Failed to upload Facebook photo");
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
    throw new Error("Failed to upload Facebook photo binary");
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
    throw new Error("Failed to publish Facebook post");
  }

  return response.json();
}
