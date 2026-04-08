# Production Checklist

## 1. Infrastructure

- [ ] MongoDB Atlas is ready
- [ ] Production domain is ready
- [ ] Vercel project is created
- [ ] `NEXT_PUBLIC_APP_URL` points to the live domain

## 2. Environment Variables

- [ ] `NEXT_PUBLIC_APP_URL`
- [ ] `MONGODB_URI`
- [ ] `JWT_SECRET`
- [ ] `CRON_SECRET`
- [ ] `OPENAI_API_KEY`
- [ ] `OPENAI_MODEL`
- [ ] `OPENAI_CONTENT_MODEL`
- [ ] `OPENAI_ANALYTICS_MODEL`
- [ ] `OPENAI_LIGHT_MODEL`
- [ ] `FACEBOOK_APP_ID`
- [ ] `FACEBOOK_APP_SECRET`
- [ ] `FACEBOOK_LOGIN_CONFIG_ID`
- [ ] `FACEBOOK_REDIRECT_URI`
- [ ] `FACEBOOK_AUTH_REDIRECT_URI`
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `GOOGLE_REDIRECT_URI`
- [ ] `GOOGLE_AUTH_REDIRECT_URI`

## 3. Google OAuth

- [ ] Add production origin
- [ ] Add `https://your-domain.com/api/auth/google/callback`
- [ ] Add `https://your-domain.com/api/google-drive/oauth/callback`
- [ ] Verify Google Drive refresh token is issued in production

## 4. Facebook OAuth

- [ ] Add app domain
- [ ] Add `https://your-domain.com/api/auth/facebook/callback`
- [ ] Add `https://your-domain.com/api/facebook/oauth/callback`
- [ ] Add Facebook Login Configuration ID to Vercel
- [ ] Confirm test user has app role while app is in development mode
- [ ] Request production permissions if needed

## 5. Deploy

- [ ] Push code to GitHub
- [ ] Import repository into Vercel
- [ ] Add environment variables
- [ ] Deploy successfully
- [ ] Confirm Setup Snapshot shows all items ready

## 6. Functional Testing

- [ ] Email/password login works
- [ ] Google login works
- [ ] Facebook login works
- [ ] Facebook Page connect works
- [ ] Google Drive connect works
- [ ] AI content generation works
- [ ] Create post works
- [ ] Schedule works
- [ ] Queue worker processes jobs
- [ ] Cron endpoint works
- [ ] Connected Accounts page shows reconnect states correctly

## 7. Final Checks

- [ ] `/privacy-policy` is accessible
- [ ] Tokens are stored securely
- [ ] Domain is connected
- [ ] SSL is active
- [ ] Logs dashboard shows auth, queue, and error events
- [ ] Rotate any secret that was shared in chat or screenshots
- [ ] Confirm Hobby cron expectation: current `vercel.json` runs once daily at 09:00 UTC
