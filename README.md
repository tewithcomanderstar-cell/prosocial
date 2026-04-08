# Prosocial System

Next.js web app for managing Facebook Pages, generating AI content, pulling images from Google Drive, and scheduling automatic posts.

## Features

- Email/password login with JWT cookie sessions
- Social login with Google and Facebook
- Multi-page Facebook connection via Graph API
- Google Drive connection for image folders and media selection
- AI content generation for captions and hashtags
- One-time and recurring scheduling
- Queue, retry, rate limit, duplicate protection, and logs
- Analytics, personas, templates, team workspace, and settings
- Privacy Policy page at `/privacy-policy`

## Requirements

- Node.js 20+
- MongoDB
- OpenAI API key
- Google OAuth credentials
- Facebook app credentials

## Tech Stack

- Frontend: Next.js 15 App Router + React 19
- Backend: Next.js Route Handlers
- Database: MongoDB + Mongoose
- AI: OpenAI Responses API
- Deployment: Vercel

## AI Models

- `OPENAI_MODEL` or `OPENAI_CONTENT_MODEL`: `gpt-5-mini`
- `OPENAI_ANALYTICS_MODEL`: `gpt-5.2`
- `OPENAI_LIGHT_MODEL`: `gpt-5-nano`

If you want only one model, use `gpt-5-mini`.

## Project Structure

```text
app/
  api/
  analytics/
  connections/
  integrations/
  login/
  media-library/
  planner/
  posts/
  privacy-policy/
  schedules/
  settings/
  team/
components/
lib/
models/
.env.example
README.md
vercel.json
```

## Local Setup

1. Install dependencies

```bash
npm install
```

2. Copy environment variables

```bash
cp .env.example .env.local
```

For Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

3. Fill these values in `.env.local`

- `NEXT_PUBLIC_APP_URL`
- `MONGODB_URI`
- `JWT_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_CONTENT_MODEL`
- `OPENAI_ANALYTICS_MODEL`
- `OPENAI_LIGHT_MODEL`
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`
- `FACEBOOK_REDIRECT_URI`
- `FACEBOOK_AUTH_REDIRECT_URI`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_AUTH_REDIRECT_URI`
- `CRON_SECRET`

4. Run development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Social Login Setup

### Google Login

- Create OAuth credentials in Google Cloud Console
- Add authorized redirect URI:
  - `http://localhost:3000/api/auth/google/callback`
- Add authorized origin:
  - `http://localhost:3000`
- Scopes used:
  - `openid`
  - `email`
  - `profile`

### Facebook Login

- Create an app in Meta for Developers
- Enable Facebook Login
- Add valid OAuth redirect URI:
  - `http://localhost:3000/api/auth/facebook/callback`
- Permissions used:
  - `email`
  - `public_profile`

Users who sign in with Google or Facebook are created automatically on first login.

## Facebook Page and Google Drive OAuth

### Facebook Page Connection

- Set redirect URI:
  - `http://localhost:3000/api/facebook/oauth/callback`
- Permissions commonly needed:
  - `pages_show_list`
  - `pages_read_engagement`
  - `pages_manage_posts`

### Google Drive Connection

- Enable Google Drive API
- Set redirect URI:
  - `http://localhost:3000/api/google-drive/oauth/callback`

## Automated Posting Flow

1. Login
2. Connect Facebook Pages
3. Connect Google Drive
4. Create or generate content
5. Select media and pages
6. Create an instant post or schedule
7. Let cron trigger `/api/cron/process-schedules`

## Deploy to Vercel

1. Push the project to GitHub
2. Import the repository into Vercel
3. Add all environment variables from `.env.local`
4. Change local URLs to your production domain
5. Redeploy

### Production Environment Example

```env
NEXT_PUBLIC_APP_URL=https://your-domain.com
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.mongodb.net/facebook-auto-posting
FACEBOOK_REDIRECT_URI=https://your-domain.com/api/facebook/oauth/callback
FACEBOOK_AUTH_REDIRECT_URI=https://your-domain.com/api/auth/facebook/callback
GOOGLE_REDIRECT_URI=https://your-domain.com/api/google-drive/oauth/callback
GOOGLE_AUTH_REDIRECT_URI=https://your-domain.com/api/auth/google/callback
```

### Vercel Cron

`vercel.json` is included and runs `/api/cron/process-schedules` every 10 minutes.

## Production Notes

- Use MongoDB Atlas for production
- Facebook production posting requires app review and approved permissions
- Google and Facebook OAuth redirect URLs must match exactly
- Store all secrets in Vercel environment variables
- Do not commit `.env.local`

## Deployment Checklist

Use [PRODUCTION_CHECKLIST.md](D:/html/PRODUCTION_CHECKLIST.md) before going live.
