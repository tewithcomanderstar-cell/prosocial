import { RouteError } from "@/lib/api";
import { fetchWithRetry } from "@/lib/services/http";

type GoogleErrorPayload = {
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: Array<{ message?: string; reason?: string }>;
      };
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
      | "google_drive_fetch_failed"
      | "google_drive_token_invalid",
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
  const description = getGoogleErrorDescription(payload, fallbackMessage).toLowerCase();

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

function getGoogleErrorDescription(payload: GoogleErrorPayload | null, fallbackMessage: string) {
  if (!payload) {
    return fallbackMessage;
  }

  if (typeof payload.error === "object" && payload.error !== null) {
    const nestedParts = [
      payload.error.message,
      payload.error.status,
      ...(payload.error.errors ?? []).flatMap((item) => [item.reason, item.message])
    ].filter(Boolean);
    if (nestedParts.length > 0) {
      return nestedParts.join(" ");
    }
  }

  return String(payload.error_description || payload.error || fallbackMessage);
}

function classifyGoogleDriveFetchError(payload: GoogleErrorPayload | null, fallbackMessage: string) {
  const description = getGoogleErrorDescription(payload, fallbackMessage).toLowerCase();

  if (
    description.includes("invalid credentials") ||
    description.includes("invalid_token") ||
    description.includes("token") ||
    description.includes("auth")
  ) {
    return new GoogleDriveServiceError(
      "Google Drive access token is invalid.",
      "google_drive_token_invalid",
      401,
      payload
    );
  }

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

async function fetchGoogleDriveJson<T>(url: URL, accessToken: string, fallbackMessage: string) {
  let response: Response;

  try {
    response = await fetchWithRetry(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store"
    });
  } catch (error) {
    throw new GoogleDriveServiceError(
      fallbackMessage,
      "google_drive_fetch_failed",
      502,
      error instanceof Error ? error.message : "Google Drive request failed"
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
    throw classifyGoogleDriveFetchError(payload, fallbackMessage);
  }

  return response.json() as Promise<T>;
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

  return fetchGoogleDriveJson<{ files: Array<{ id: string; name: string }> }>(
    url,
    accessToken,
    "Failed to fetch Google Drive folders"
  );
}

export async function fetchImagesFromFolder(accessToken: string, folderId: string, maxFiles = 200) {
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
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("orderBy", "createdTime desc,name_natural");

    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken);
    }

    const payload = await fetchGoogleDriveJson<{
      nextPageToken?: string;
      files?: Array<{
        id: string;
        name: string;
        mimeType?: string;
        thumbnailLink?: string;
        webContentLink?: string;
        webViewLink?: string;
      }>;
    }>(url, accessToken, "Failed to fetch Google Drive images");

    files.push(...(payload.files ?? []));
    nextPageToken = files.length >= maxFiles ? undefined : payload.nextPageToken;
  } while (nextPageToken);

  return { files: files.slice(0, maxFiles) };
}

export async function fetchDriveImageBinary(accessToken: string, fileId: string) {
  let response: Response;

  try {
    response = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store"
    });
  } catch (error) {
    throw new GoogleDriveServiceError(
      "Failed to download Google Drive image",
      "google_drive_fetch_failed",
      502,
      error instanceof Error ? error.message : "Google Drive image request failed"
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
    throw classifyGoogleDriveFetchError(payload, "Failed to download Google Drive image");
  }

  return {
    bytes: await response.arrayBuffer(),
    mimeType: response.headers.get("content-type") || "image/jpeg"
  };
}
