import { RouteError } from "@/lib/api";
import { fetchWithRetry } from "@/lib/services/http";

type GoogleErrorPayload = {
  error?: string;
  error_description?: string;
  error_uri?: string;
};

export class GoogleDriveServiceError extends RouteError {
  constructor(
    message: string,
    public readonly code:
      | "google_missing_env"
      | "google_redirect_uri_mismatch"
      | "google_token_exchange_failed"
      | "google_drive_scope_missing"
      | "google_drive_fetch_failed",
    status = 500,
    public readonly details?: GoogleErrorPayload | string | null
  ) {
    super(message, status, code);
    this.name = "GoogleDriveServiceError";
  }
}

function assertGoogleOAuthConfig(redirectUri?: string | null) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const resolvedRedirectUri = redirectUri?.trim() || process.env.GOOGLE_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !resolvedRedirectUri) {
    throw new GoogleDriveServiceError(
      "Google Drive OAuth is not configured correctly.",
      "google_missing_env",
      500
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri: resolvedRedirectUri
  };
}

function classifyGoogleOAuthError(payload: GoogleErrorPayload, fallbackMessage: string) {
  const description = String(payload.error_description || payload.error || fallbackMessage).toLowerCase();

  if (description.includes("redirect_uri") || description.includes("mismatch")) {
    return new GoogleDriveServiceError(
      "Google redirect URI mismatch.",
      "google_redirect_uri_mismatch",
      400,
      payload
    );
  }

  return new GoogleDriveServiceError(
    "Google token exchange failed.",
    "google_token_exchange_failed",
    502,
    payload
  );
}

function classifyGoogleDriveFetchError(payload: GoogleErrorPayload | null, fallbackMessage: string) {
  const description = String(payload?.error_description || payload?.error || fallbackMessage).toLowerCase();

  if (description.includes("insufficient") || description.includes("scope") || description.includes("permission")) {
    return new GoogleDriveServiceError(
      "Google Drive scope is missing.",
      "google_drive_scope_missing",
      403,
      payload
    );
  }

  return new GoogleDriveServiceError(
    fallbackMessage,
    "google_drive_fetch_failed",
    502,
    payload
  );
}

export function getGoogleOAuthUrl(options?: { redirectUri?: string | null; state?: string | null }) {
  const config = assertGoogleOAuthConfig(options?.redirectUri);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
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
  const config = assertGoogleOAuthConfig(redirectUri);
  const response = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code"
    })
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as GoogleErrorPayload;
    throw classifyGoogleOAuthError(payload, "Failed to exchange Google code");
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
    const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
    throw classifyGoogleDriveFetchError(payload, "Failed to fetch Google Drive folders");
  }

  return response.json() as Promise<{ files: Array<{ id: string; name: string }> }>;
}

export async function fetchImagesFromFolder(accessToken: string, folderId: string) {
  const rootQuery =
    folderId === "root"
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
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,thumbnailLink,webContentLink,webViewLink)"
    );
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
      const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
      throw classifyGoogleDriveFetchError(payload, "Failed to fetch Google Drive images");
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
    const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
    throw classifyGoogleDriveFetchError(payload, "Failed to download Google Drive image");
  }

  return {
    bytes: await response.arrayBuffer(),
    mimeType: response.headers.get("content-type") || "image/jpeg"
  };
}
