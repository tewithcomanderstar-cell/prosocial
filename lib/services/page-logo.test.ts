import assert from "node:assert/strict";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import { getPageLogoForDestinationCore, getPageLogoForFacebookPageCore } from "./page-logo-core.ts";

const sampleLogo = {
  bytes: Uint8Array.from([1, 2, 3, 4]).buffer,
  mimeType: "image/png"
};

async function main() {
  let cachedRefreshCalled = false;

  const cachedResult = await getPageLogoForFacebookPageCore(
    {
      userId: "user-1",
      pageId: "page-2",
      cacheWindowMs: 24 * 60 * 60 * 1000,
      connection: {
        pages: [
          {
            pageId: "page-1",
            pageAccessToken: "token-1",
            profilePictureUrl: "https://cdn.example.com/page-1.png",
            profilePictureFetchedAt: new Date()
          },
          {
            pageId: "page-2",
            pageAccessToken: "token-2",
            profilePictureUrl: "https://cdn.example.com/page-2.png",
            profilePictureFetchedAt: new Date()
          }
        ]
      }
    },
    {
      findFacebookConnectionByUserId: async () => null,
      updateFacebookConnectionPageLogo: async () => {
        cachedRefreshCalled = true;
      },
      findDestinationById: async () => null,
      findAccountById: async () => null,
      fetchPageProfileImage: async ({ cachedUrl }) => {
        assert.equal(cachedUrl, "https://cdn.example.com/page-2.png");
        return sampleLogo;
      },
      downloadImageBinary: async () => sampleLogo,
      fetchPageProfilePictureUrl: async () => {
        throw new Error("should not refresh");
      }
    }
  );

  assert.equal(cachedResult.source, "cached");
  assert.equal(cachedResult.profilePictureUrl, "https://cdn.example.com/page-2.png");
  assert.equal(cachedRefreshCalled, false);
  console.log("PASS getPageLogoForFacebookPage returns cached logo for the correct page");

  const destinationResult = await getPageLogoForDestinationCore("dest-2", { cacheWindowMs: 24 * 60 * 60 * 1000 }, {
    findFacebookConnectionByUserId: async () => ({
      pages: [
        {
          pageId: "page-1",
          pageAccessToken: "token-1",
          profilePictureUrl: "https://cdn.example.com/page-1.png",
          profilePictureFetchedAt: null
        },
        {
          pageId: "page-2",
          pageAccessToken: "token-2",
          profilePictureUrl: "https://cdn.example.com/page-2.png",
          profilePictureFetchedAt: null
        }
      ]
    }),
    updateFacebookConnectionPageLogo: async () => undefined,
    findDestinationById: async (destinationId) =>
      destinationId === "dest-2"
        ? {
            accountId: "account-1",
            externalDestinationId: "page-2"
          }
        : null,
    findAccountById: async (accountId) =>
      accountId === "account-1"
        ? {
            userId: "user-1"
          }
        : null,
    fetchPageProfileImage: async ({ cachedUrl }) => {
      assert.equal(cachedUrl, "https://cdn.example.com/page-2-refreshed.png");
      return sampleLogo;
    },
    downloadImageBinary: async () => sampleLogo,
    fetchPageProfilePictureUrl: async () => "https://cdn.example.com/page-2-refreshed.png"
  });

  assert.equal(destinationResult.profilePictureUrl, "https://cdn.example.com/page-2-refreshed.png");
  assert.equal(destinationResult.source, "refreshed");
  console.log("PASS getPageLogoForDestination resolves the correct destination logo");

  const missingResult = await getPageLogoForFacebookPageCore(
    {
      userId: "user-1",
      pageId: "page-404",
      cacheWindowMs: 24 * 60 * 60 * 1000,
      connection: {
        pages: [
          {
            pageId: "page-404",
            pageAccessToken: "token-404",
            profilePictureUrl: null,
            profilePictureFetchedAt: null
          }
        ]
      }
    },
    {
      findFacebookConnectionByUserId: async () => null,
      updateFacebookConnectionPageLogo: async () => undefined,
      findDestinationById: async () => null,
      findAccountById: async () => null,
      fetchPageProfileImage: async () => {
        throw new Error("download failed");
      },
      downloadImageBinary: async () => {
        throw new Error("no fallback");
      },
      fetchPageProfilePictureUrl: async () => {
        throw new Error("provider unavailable");
      }
    }
  );

  assert.equal(missingResult.image, null);
  assert.equal(missingResult.source, "missing");
  console.log("PASS logo fetch failure returns a safe missing result without crashing");
}

void main().catch((error) => {
  console.error("FAIL page logo tests");
  throw error;
});
