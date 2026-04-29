import assert from "node:assert/strict";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import { getFacebookPageConnectDebugInfo, resolveFacebookPageConnectScope } from "./facebook-oauth-debug.ts";

function main() {
  const defaultScope = resolveFacebookPageConnectScope({});
  assert.equal(defaultScope, "pages_show_list");
  console.log("PASS page connect scope defaults to pages_show_list");

  const ignoredLegacyScope = resolveFacebookPageConnectScope({
    FACEBOOK_PAGE_CONNECT_SCOPE: "pages_show_list,pages_manage_metadata"
  });
  assert.equal(ignoredLegacyScope, "pages_show_list");
  console.log("PASS stale FACEBOOK_PAGE_CONNECT_SCOPE is ignored unless explicitly forced");

  const forcedScope = resolveFacebookPageConnectScope({
    FACEBOOK_PAGE_CONNECT_SCOPE: "pages_show_list,pages_manage_metadata",
    FACEBOOK_PAGE_CONNECT_SCOPE_FORCE: "true"
  });
  assert.equal(forcedScope, "pages_show_list,pages_manage_metadata");
  console.log("PASS explicit FACEBOOK_PAGE_CONNECT_SCOPE can still be forced intentionally");

  const debugInfo = getFacebookPageConnectDebugInfo({
    FACEBOOK_PAGE_CONNECT_SCOPE: "pages_show_list,pages_manage_metadata",
    FACEBOOK_PAGE_CONNECT_EXTRA_SCOPE: "pages_read_engagement",
    FACEBOOK_LOGIN_CONFIG_ID: "1685723135915988",
    FACEBOOK_REDIRECT_URI: "https://prosocial-app-theta.vercel.app/api/facebook/oauth/callback",
    FACEBOOK_AUTH_REDIRECT_URI: "https://prosocial-app-theta.vercel.app/api/auth/facebook/callback",
    NEXT_PUBLIC_APP_URL: "https://prosocial-app-theta.vercel.app"
  });

  assert.equal(debugInfo.ignoredLegacyScopePresent, true);
  assert.equal(debugInfo.effectiveScope, "pages_show_list,pages_read_engagement");
  assert.equal(debugInfo.configIdEnabled, true);
  assert.equal(debugInfo.configIdSource, "FACEBOOK_LOGIN_CONFIG_ID");
  assert.equal(debugInfo.facebookRedirectUri, "https://prosocial-app-theta.vercel.app/api/facebook/oauth/callback");
  console.log("PASS Facebook OAuth debug info reports ignored legacy scope, active redirect URIs, and config_id usage");
}

try {
  main();
} catch (error) {
  console.error("FAIL facebook scope tests");
  throw error;
}
