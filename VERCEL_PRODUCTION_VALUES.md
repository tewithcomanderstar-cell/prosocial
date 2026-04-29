# Vercel Production Values

Production URL:

```text
https://prosocial-app-theta.vercel.app
```

## Environment Variables

Add these in Vercel Project Settings -> Environment Variables.

```env
NEXT_PUBLIC_APP_URL=https://prosocial-app-theta.vercel.app
MONGODB_URI=your-mongodb-atlas-uri
JWT_SECRET=replace-with-a-long-random-secret
CRON_SECRET=replace-with-cron-secret

OPENAI_API_KEY=replace-with-a-new-openai-key
OPENAI_MODEL=gpt-5-mini
OPENAI_CONTENT_MODEL=gpt-5-mini
OPENAI_ANALYTICS_MODEL=gpt-5.2
OPENAI_LIGHT_MODEL=gpt-5-nano

FACEBOOK_APP_ID=your-facebook-app-id
FACEBOOK_APP_SECRET=your-facebook-app-secret
FACEBOOK_LOGIN_CONFIG_ID=your-facebook-login-config-id
FACEBOOK_AUTH_REDIRECT_URI=https://prosocial-app-theta.vercel.app/api/auth/facebook/callback
FACEBOOK_REDIRECT_URI=https://prosocial-app-theta.vercel.app/api/facebook/oauth/callback

GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=https://prosocial-app-theta.vercel.app/api/google-drive/oauth/callback
GOOGLE_AUTH_REDIRECT_URI=https://prosocial-app-theta.vercel.app/api/auth/google/callback
```

Optional Facebook Pages OAuth debug envs:

```env
# Leave this unset unless you intentionally need to override the default page-connect scope.
FACEBOOK_PAGE_CONNECT_SCOPE=

# Only set true if you explicitly want to force FACEBOOK_PAGE_CONNECT_SCOPE.
FACEBOOK_PAGE_CONNECT_SCOPE_FORCE=false

# Optional extra scopes appended on top of pages_show_list.
FACEBOOK_PAGE_CONNECT_EXTRA_SCOPE=
```

## Google OAuth

Set these in Google Cloud Console.

Authorized JavaScript origins:

```text
https://prosocial-app-theta.vercel.app
```

Authorized redirect URIs:

```text
https://prosocial-app-theta.vercel.app/api/auth/google/callback
https://prosocial-app-theta.vercel.app/api/google-drive/oauth/callback
```

## Facebook Login

Set these in Meta for Developers.

App Domains:

```text
prosocial-app-theta.vercel.app
```

Valid OAuth Redirect URIs:

```text
https://prosocial-app-theta.vercel.app/api/auth/facebook/callback
https://prosocial-app-theta.vercel.app/api/facebook/oauth/callback
```

## Recommended Next Step

- Rotate the current OpenAI key and use the new key in Vercel only
- Replace local MongoDB with MongoDB Atlas
- Test login, AI generate, Facebook connect, and Google Drive connect
