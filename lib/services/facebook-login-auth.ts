export function resolveFacebookLoginConfigId(env: Record<string, string | undefined> = process.env) {
  const configId = env.FACEBOOK_LOGIN_CONFIG_ID?.trim() || null;
  const mode = env.FACEBOOK_LOGIN_USE_CONFIG_ID;

  if (!configId) {
    return {
      enabled: false,
      configId: null,
      source: null
    };
  }

  if (mode === "false") {
    return {
      enabled: false,
      configId: null,
      source: "FACEBOOK_LOGIN_USE_CONFIG_ID" as const
    };
  }

  return {
    enabled: true,
    configId,
    source: mode === "true"
      ? ("FACEBOOK_LOGIN_USE_CONFIG_ID" as const)
      : ("FACEBOOK_LOGIN_CONFIG_ID" as const)
  };
}
