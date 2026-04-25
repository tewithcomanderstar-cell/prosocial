export type CachedConnectedPage = {
  pageId: string;
  pageAccessToken: string;
  profilePictureUrl?: string | null;
  profilePictureFetchedAt?: Date | string | null;
};

export type CachedFacebookConnection = {
  _id?: string;
  userId?: string;
  pages?: CachedConnectedPage[];
};

export type DestinationRecord = {
  _id?: string;
  accountId: string;
  externalDestinationId: string;
};

export type AccountRecord = {
  _id?: string;
  userId: string;
};

export type LogoBinary = {
  bytes: ArrayBuffer;
  mimeType: string;
};

export type PageLogoResult = {
  image: LogoBinary | null;
  profilePictureUrl: string | null;
  source: "cached" | "refreshed" | "fallback" | "missing";
};

export type PageLogoDeps = {
  findFacebookConnectionByUserId: (userId: string) => Promise<CachedFacebookConnection | null>;
  updateFacebookConnectionPageLogo: (
    userId: string,
    pageId: string,
    profilePictureUrl: string | null,
    fetchedAt: Date
  ) => Promise<void>;
  findDestinationById: (destinationId: string) => Promise<DestinationRecord | null>;
  findAccountById: (accountId: string) => Promise<AccountRecord | null>;
  fetchPageProfileImage: (params: {
    pageId: string;
    pageAccessToken: string;
    cachedUrl?: string | null;
  }) => Promise<LogoBinary>;
  fetchPageProfilePictureUrl: (params: { pageId: string; pageAccessToken: string }) => Promise<string>;
  downloadImageBinary: (url: string) => Promise<LogoBinary>;
};

export function isFreshProfilePicture(fetchedAt: Date | string | null | undefined, cacheWindowMs: number) {
  if (!fetchedAt) {
    return false;
  }

  const value = new Date(fetchedAt).getTime();
  if (Number.isNaN(value)) {
    return false;
  }

  return Date.now() - value < cacheWindowMs;
}

async function getDefaultLogo(
  deps: PageLogoDeps,
  defaultLogoUrl?: string | null
): Promise<PageLogoResult> {
  const fallbackLogoUrl = defaultLogoUrl?.trim();
  if (!fallbackLogoUrl) {
    return {
      image: null,
      profilePictureUrl: null,
      source: "missing"
    };
  }

  try {
    const image = await deps.downloadImageBinary(fallbackLogoUrl);
    return {
      image,
      profilePictureUrl: fallbackLogoUrl,
      source: "fallback"
    };
  } catch {
    return {
      image: null,
      profilePictureUrl: fallbackLogoUrl,
      source: "missing"
    };
  }
}

export async function getPageLogoForFacebookPageCore(
  params: {
    userId: string;
    pageId: string;
    connection?: CachedFacebookConnection | null;
    forceRefresh?: boolean;
    defaultLogoUrl?: string | null;
    cacheWindowMs: number;
  },
  deps: PageLogoDeps
): Promise<PageLogoResult> {
  const connection = params.connection ?? (await deps.findFacebookConnectionByUserId(params.userId));
  const page = connection?.pages?.find((item) => item.pageId === params.pageId);

  if (!page?.pageAccessToken) {
    return getDefaultLogo(deps, params.defaultLogoUrl);
  }

  const cachedUrl = page.profilePictureUrl ?? null;
  const canUseCached = Boolean(
    cachedUrl && !params.forceRefresh && isFreshProfilePicture(page.profilePictureFetchedAt, params.cacheWindowMs)
  );

  if (canUseCached) {
    try {
      const image = await deps.fetchPageProfileImage({
        pageId: page.pageId,
        pageAccessToken: page.pageAccessToken,
        cachedUrl
      });
      return {
        image,
        profilePictureUrl: cachedUrl,
        source: "cached"
      };
    } catch {}
  }

  try {
    const freshUrl = await deps.fetchPageProfilePictureUrl({
      pageId: page.pageId,
      pageAccessToken: page.pageAccessToken
    });
    const image = await deps.fetchPageProfileImage({
      pageId: page.pageId,
      pageAccessToken: page.pageAccessToken,
      cachedUrl: freshUrl
    });

    await deps.updateFacebookConnectionPageLogo(params.userId, page.pageId, freshUrl, new Date());
    return {
      image,
      profilePictureUrl: freshUrl,
      source: "refreshed"
    };
  } catch {
    if (cachedUrl) {
      try {
        const image = await deps.fetchPageProfileImage({
          pageId: page.pageId,
          pageAccessToken: page.pageAccessToken,
          cachedUrl
        });
        return {
          image,
          profilePictureUrl: cachedUrl,
          source: "fallback"
        };
      } catch {}
    }

    const fallback = await getDefaultLogo(deps, params.defaultLogoUrl);
    if (fallback.image) {
      return fallback;
    }

    return {
      image: null,
      profilePictureUrl: cachedUrl,
      source: "missing"
    };
  }
}

export async function getPageLogoForDestinationCore(
  destinationId: string,
  params: {
    defaultLogoUrl?: string | null;
    cacheWindowMs: number;
  },
  deps: PageLogoDeps
): Promise<PageLogoResult> {
  const destination = await deps.findDestinationById(destinationId);
  if (!destination) {
    return getDefaultLogo(deps, params.defaultLogoUrl);
  }

  const account = await deps.findAccountById(destination.accountId);
  if (!account) {
    return getDefaultLogo(deps, params.defaultLogoUrl);
  }

  return getPageLogoForFacebookPageCore(
    {
      userId: String(account.userId),
      pageId: destination.externalDestinationId,
      defaultLogoUrl: params.defaultLogoUrl,
      cacheWindowMs: params.cacheWindowMs
    },
    deps
  );
}
