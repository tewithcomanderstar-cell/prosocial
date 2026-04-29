export function resolveFacebookPageConnectScope(env: Record<string, string | undefined> = process.env) {
  const explicitScope = env.FACEBOOK_PAGE_CONNECT_SCOPE?.trim();
  const forceExplicitScope = env.FACEBOOK_PAGE_CONNECT_SCOPE_FORCE === "true";
  if (explicitScope && forceExplicitScope) {
    return explicitScope;
  }

  const extraScope = env.FACEBOOK_PAGE_CONNECT_EXTRA_SCOPE?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const baseScope = ["pages_show_list"];
  const merged = [...baseScope, ...(extraScope ?? [])];

  return Array.from(new Set(merged)).join(",");
}

export function getFacebookPageConnectDebugInfo(env: Record<string, string | undefined> = process.env) {
  const explicitScope = env.FACEBOOK_PAGE_CONNECT_SCOPE?.trim() || null;
  const extraScope = env.FACEBOOK_PAGE_CONNECT_EXTRA_SCOPE?.trim() || null;
  const forceExplicitScope = env.FACEBOOK_PAGE_CONNECT_SCOPE_FORCE === "true";

  return {
    effectiveScope: resolveFacebookPageConnectScope(env),
    explicitScopeConfigured: Boolean(explicitScope),
    explicitScopeForced: forceExplicitScope,
    explicitScopeValue: forceExplicitScope ? explicitScope : null,
    ignoredLegacyScopePresent: Boolean(explicitScope && !forceExplicitScope),
    extraScopeConfigured: extraScope,
    facebookRedirectUri: env.FACEBOOK_REDIRECT_URI || null,
    facebookAuthRedirectUri: env.FACEBOOK_AUTH_REDIRECT_URI || null,
    nextPublicAppUrl: env.NEXT_PUBLIC_APP_URL || null,
    facebookLoginConfigIdPresent: Boolean(env.FACEBOOK_LOGIN_CONFIG_ID),
    facebookLoginUseConfigId: env.FACEBOOK_LOGIN_USE_CONFIG_ID === "true"
  };
}
