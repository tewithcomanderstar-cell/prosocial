import { fetchWithRetry } from "@/lib/services/http";

type FacebookPage = {
  id: string;
  name: string;
  access_token: string;
  category?: string;
};

export function getFacebookOAuthUrl() {
  const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  url.searchParams.set("client_id", process.env.FACEBOOK_APP_ID ?? "");
  url.searchParams.set("redirect_uri", process.env.FACEBOOK_REDIRECT_URI ?? "");
  url.searchParams.set("scope", process.env.FACEBOOK_PAGE_CONNECT_SCOPE ?? "pages_show_list");
  return url.toString();
}

export async function exchangeFacebookCode(code: string) {
  const url = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  url.searchParams.set("client_id", process.env.FACEBOOK_APP_ID ?? "");
  url.searchParams.set("client_secret", process.env.FACEBOOK_APP_SECRET ?? "");
  url.searchParams.set("redirect_uri", process.env.FACEBOOK_REDIRECT_URI ?? "");
  url.searchParams.set("code", code);

  const response = await fetchWithRetry(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to exchange Facebook code");
  }

  return response.json() as Promise<{ access_token: string; expires_in?: number }>;
}

export async function fetchFacebookPages(userAccessToken: string) {
  const url = new URL("https://graph.facebook.com/v21.0/me/accounts");
  url.searchParams.set("access_token", userAccessToken);

  const response = await fetchWithRetry(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch Facebook pages");
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
