import { Account } from "@/models/Account";
import { Destination } from "@/models/Destination";
import { FacebookConnection } from "@/models/FacebookConnection";
import {
  downloadRemoteImageBinary,
  fetchFacebookPageProfileImage,
  fetchFacebookPageProfilePictureUrl
} from "@/lib/services/facebook";
import {
  type PageLogoDeps,
  getPageLogoForDestinationCore,
  getPageLogoForFacebookPageCore
} from "@/lib/services/page-logo-core";

const PAGE_LOGO_CACHE_WINDOW_MS = Number(
  process.env.FACEBOOK_PAGE_LOGO_CACHE_WINDOW_MS ?? String(24 * 60 * 60 * 1000)
);

const defaultDeps: PageLogoDeps = {
  async findFacebookConnectionByUserId(userId) {
    return (await FacebookConnection.findOne({ userId }).lean()) as {
      _id?: string;
      userId?: string;
      pages?: Array<{
        pageId: string;
        pageAccessToken: string;
        profilePictureUrl?: string | null;
        profilePictureFetchedAt?: Date | string | null;
      }>;
    } | null;
  },
  async updateFacebookConnectionPageLogo(userId, pageId, profilePictureUrl, fetchedAt) {
    await FacebookConnection.updateOne(
      { userId, "pages.pageId": pageId },
      {
        $set: {
          "pages.$.profilePictureUrl": profilePictureUrl,
          "pages.$.profilePictureFetchedAt": fetchedAt
        }
      }
    );
  },
  async findDestinationById(destinationId) {
    return (await Destination.findById(destinationId).lean()) as {
      _id?: string;
      accountId: string;
      externalDestinationId: string;
    } | null;
  },
  async findAccountById(accountId) {
    return (await Account.findById(accountId).lean()) as {
      _id?: string;
      userId: string;
    } | null;
  },
  fetchPageProfileImage: fetchFacebookPageProfileImage,
  fetchPageProfilePictureUrl: fetchFacebookPageProfilePictureUrl,
  downloadImageBinary: downloadRemoteImageBinary
};

export async function getPageLogoForFacebookPage(
  params: {
    userId: string;
    pageId: string;
    connection?: {
      _id?: string;
      userId?: string;
      pages?: Array<{
        pageId: string;
        pageAccessToken: string;
        profilePictureUrl?: string | null;
        profilePictureFetchedAt?: Date | string | null;
      }>;
    } | null;
    forceRefresh?: boolean;
  },
  deps: PageLogoDeps = defaultDeps
) {
  return getPageLogoForFacebookPageCore(
    {
      ...params,
      defaultLogoUrl: process.env.DEFAULT_WATERMARK_LOGO_URL ?? null,
      cacheWindowMs: PAGE_LOGO_CACHE_WINDOW_MS
    },
    deps
  );
}

export async function getPageLogoForDestination(destinationId: string, deps: PageLogoDeps = defaultDeps) {
  return getPageLogoForDestinationCore(
    destinationId,
    {
      defaultLogoUrl: process.env.DEFAULT_WATERMARK_LOGO_URL ?? null,
      cacheWindowMs: PAGE_LOGO_CACHE_WINDOW_MS
    },
    deps
  );
}

export async function refreshLogoForDestination(destinationId: string, deps: PageLogoDeps = defaultDeps) {
  const destination = await deps.findDestinationById(destinationId);
  if (!destination) {
    return getPageLogoForDestinationCore(
      destinationId,
      {
        defaultLogoUrl: process.env.DEFAULT_WATERMARK_LOGO_URL ?? null,
        cacheWindowMs: PAGE_LOGO_CACHE_WINDOW_MS
      },
      deps
    );
  }

  const account = await deps.findAccountById(destination.accountId);
  if (!account) {
    return getPageLogoForDestinationCore(
      destinationId,
      {
        defaultLogoUrl: process.env.DEFAULT_WATERMARK_LOGO_URL ?? null,
        cacheWindowMs: PAGE_LOGO_CACHE_WINDOW_MS
      },
      deps
    );
  }

  return getPageLogoForFacebookPageCore(
    {
      userId: String(account.userId),
      pageId: destination.externalDestinationId,
      forceRefresh: true,
      defaultLogoUrl: process.env.DEFAULT_WATERMARK_LOGO_URL ?? null,
      cacheWindowMs: PAGE_LOGO_CACHE_WINDOW_MS
    },
    deps
  );
}
