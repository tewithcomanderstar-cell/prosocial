# Vercel Production Values

Production URL:

```text
https://prosocial-y98m.vercel.app
```

## Environment Variables

Add these in Vercel Project Settings -> Environment Variables.

```env
NEXT_PUBLIC_APP_URL=https://prosocial-y98m.vercel.app
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
FACEBOOK_REDIRECT_URI=https://prosocial-y98m.vercel.app/api/facebook/oauth/callback
FACEBOOK_AUTH_REDIRECT_URI=https://prosocial-y98m.vercel.app/api/auth/facebook/callback

GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=https://prosocial-y98m.vercel.app/api/google-drive/oauth/callback
GOOGLE_AUTH_REDIRECT_URI=https://prosocial-y98m.vercel.app/api/auth/google/callback
```

## Google OAuth

Set these in Google Cloud Console.

Authorized JavaScript origins:

```text
https://prosocial-y98m.vercel.app
```

Authorized redirect URIs:

```text
https://prosocial-y98m.vercel.app/api/auth/google/callback
https://prosocial-y98m.vercel.app/api/google-drive/oauth/callback
```

## Facebook Login

Set these in Meta for Developers.

App Domains:

```text
prosocial-y98m.vercel.app
```

Valid OAuth Redirect URIs:

```text
https://prosocial-y98m.vercel.app/api/auth/facebook/callback
https://prosocial-y98m.vercel.app/api/facebook/oauth/callback
```

## Recommended Next Step

- Rotate the current OpenAI key and use the new key in Vercel only
- Replace local MongoDB with MongoDB Atlas
- Test login, AI generate, Facebook connect, and Google Drive connect
