import { fetchWithRetry } from "@/lib/services/http";

export function getGoogleOAuthUrl(options?: { redirectUri?: string | null; state?: string | null }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", options?.redirectUri?.trim() || (process.env.GOOGLE_REDIRECT_URI ?? ""));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email"
  );
  url.searchParams.set("prompt", "consent");
  if (options?.state) {
    url.searchParams.set("state", options.state);
  }
  return url.toString();
}

export async function exchangeGoogleCode(code: string, redirectUri?: string | null) {
  const response = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri?.trim() || (process.env.GOOGLE_REDIRECT_URI ?? ""),
      grant_type: "authorization_code"
    })
  });

  if (!response.ok) {
    throw new Error("Failed to exchange Google code");
  }

  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>;
}

export async function fetchDriveFolders(accessToken: string, parentId = "root") {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("orderBy", "folder,name_natural");

  const response = await fetchWithRetry(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("Failed to fetch Google Drive folders");
  }

  return response.json() as Promise<{ files: Array<{ id: string; name: string }> }>;
}

export async function fetchImagesFromFolder(accessToken: string, folderId: string) {
  const rootQuery = folderId === "root"
    ? "'root' in parents and mimeType contains 'image/' and trashed = false"
    : `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`;
  const files: Array<{
    id: string;
    name: string;
    mimeType?: string;
    thumbnailLink?: string;
    webContentLink?: string;
    webViewLink?: string;
  }> = [];

  let nextPageToken: string | undefined;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", rootQuery);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,thumbnailLink,webContentLink,webViewLink)");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("orderBy", "createdTime desc,name_natural");

    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken);
    }

    const response = await fetchWithRetry(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Failed to fetch Google Drive images");
    }

    const payload = (await response.json()) as {
      nextPageToken?: string;
      files?: Array<{
        id: string;
        name: string;
        mimeType?: string;
        thumbnailLink?: string;
        webContentLink?: string;
        webViewLink?: string;
      }>;
    };

    files.push(...(payload.files ?? []));
    nextPageToken = payload.nextPageToken;
  } while (nextPageToken);

  return { files };
}

export async function fetchDriveImageBinary(accessToken: string, fileId: string) {
  const response = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("Failed to download Google Drive image");
  }

  return {
    bytes: await response.arrayBuffer(),
    mimeType: response.headers.get("content-type") || "image/jpeg"
  };
}
