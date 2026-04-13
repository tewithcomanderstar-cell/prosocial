type SetupItem = {
  key: string;
  label: string;
  ready: boolean;
  message: string;
};

function hasValue(value: string | undefined, placeholder?: string) {
  if (!value) {
    return false;
  }

  if (placeholder && value === placeholder) {
    return false;
  }

  return true;
}

export function getSetupStatus() {
  const items: SetupItem[] = [
    {
      key: "mongodb",
      label: "MongoDB",
      ready: hasValue(process.env.MONGODB_URI),
      message: "Stores users, posts, schedules, and integration tokens."
    },
    {
      key: "app-url",
      label: "App URL",
      ready: hasValue(process.env.NEXT_PUBLIC_APP_URL),
      message: "Required for OAuth redirects, webhooks, and production callbacks."
    },
    {
      key: "jwt",
      label: "JWT Secret",
      ready: hasValue(process.env.JWT_SECRET),
      message: "Signs secure login cookies."
    },
    {
      key: "openai",
      label: "OpenAI",
      ready: hasValue(process.env.OPENAI_API_KEY, "sk-..."),
      message: "Required for AI caption and hashtag generation."
    },
    {
      key: "facebook",
      label: "Facebook OAuth",
      ready:
        hasValue(process.env.FACEBOOK_APP_ID, "your-facebook-app-id") &&
        hasValue(process.env.FACEBOOK_APP_SECRET, "your-facebook-app-secret") &&
        hasValue(process.env.FACEBOOK_AUTH_REDIRECT_URI) &&
        hasValue(process.env.FACEBOOK_REDIRECT_URI),
      message: "Required for login, page connections, and live publishing."
    },
    {
      key: "google",
      label: "Google Drive OAuth",
      ready:
        hasValue(process.env.GOOGLE_CLIENT_ID, "your-google-client-id") &&
        hasValue(process.env.GOOGLE_CLIENT_SECRET, "your-google-client-secret") &&
        hasValue(process.env.GOOGLE_AUTH_REDIRECT_URI) &&
        hasValue(process.env.GOOGLE_REDIRECT_URI),
      message: "Required for social login and browsing Drive folders."
    },
    {
      key: "cron",
      label: "Cron Secret",
      ready: hasValue(process.env.CRON_SECRET),
      message: "Protects the background schedule processing endpoint."
    }
  ];

  return {
    items,
    readyCount: items.filter((item) => item.ready).length,
    totalCount: items.length
  };
}
