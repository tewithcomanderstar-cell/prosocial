import { getRequestBaseUrl, getSocialRedirectUriForRequest } from "../social-auth";
import { getFacebookPageConnectDebugInfo } from "./facebook";

export function getOAuthConfigDebug(request?: Request | URL | string | null) {
  const appUrl = getRequestBaseUrl(request);
  const facebookPageDebug = getFacebookPageConnectDebugInfo();

  return {
    appUrl,
    facebookAuthRedirectUri: getSocialRedirectUriForRequest("facebook", request),
    facebookPageRedirectUri: `${appUrl}/api/facebook/oauth/callback`,
    googleAuthRedirectUri: getSocialRedirectUriForRequest("google", request),
    googleDriveRedirectUri: `${appUrl}/api/google-drive/oauth/callback`,
    hasFacebookAppId: Boolean(process.env.FACEBOOK_APP_ID),
    hasFacebookAppSecret: Boolean(process.env.FACEBOOK_APP_SECRET),
    hasFacebookLoginConfigId: Boolean(process.env.FACEBOOK_LOGIN_CONFIG_ID),
    hasGoogleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
    hasGoogleClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    hasMongoDbUri: Boolean(process.env.MONGODB_URI),
    hasJwtSecret: Boolean(process.env.JWT_SECRET),
    nodeEnv: process.env.NODE_ENV ?? "development",
    vercelEnv: process.env.VERCEL_ENV ?? null,
    facebookPageConnectScope: facebookPageDebug.effectiveScope,
    facebookPageConnectUsesConfigId: facebookPageDebug.configIdEnabled
  };
}
