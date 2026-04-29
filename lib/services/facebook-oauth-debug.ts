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

export function resolveFacebookPageConnectConfigId(env: Record<string, string | undefined> = process.env) {
  const explicitConfigId = env.FACEBOOK_PAGE_CONNECT_CONFIG_ID?.trim();
  if (explicitConfigId) {
    return {
      configId: explicitConfigId,
      source: "FACEBOOK_PAGE_CONNECT_CONFIG_ID" as const
    };
  }

  const loginConfigId = env.FACEBOOK_LOGIN_CONFIG_ID?.trim();
  const allowLoginConfigFallback = env.FACEBOOK_PAGE_CONNECT_USE_LOGIN_CONFIG_ID !== "false";
  if (loginConfigId && allowLoginConfigFallback) {
    return {
      configId: loginConfigId,
      source: "FACEBOOK_LOGIN_CONFIG_ID" as const
    };
  }

  return {
    configId: null,
    source: null
  };
}

export function getFacebookPageConnectDebugInfo(env: Record<string, string | undefined> = process.env) {
  const explicitScope = env.FACEBOOK_PAGE_CONNECT_SCOPE?.trim() || null;
  const extraScope = env.FACEBOOK_PAGE_CONNECT_EXTRA_SCOPE?.trim() || null;
  const forceExplicitScope = env.FACEBOOK_PAGE_CONNECT_SCOPE_FORCE === "true";
  const { configId, source } = resolveFacebookPageConnectConfigId(env);

  return {
    effectiveScope: resolveFacebookPageConnectScope(env),
    configIdEnabled: Boolean(configId),
    configIdSource: source,
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
