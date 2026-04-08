# Production Checklist

## 1. Infrastructure

- [ ] MongoDB Atlas is ready
- [ ] Production domain is ready
- [ ] Vercel project is created

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

## 4. Facebook OAuth

- [ ] Add app domain
- [ ] Add `https://your-domain.com/api/auth/facebook/callback`
- [ ] Add `https://your-domain.com/api/facebook/oauth/callback`
- [ ] Request production permissions if needed

## 5. Deploy

- [ ] Push code to GitHub
- [ ] Import repository into Vercel
- [ ] Add environment variables
- [ ] Deploy successfully

## 6. Functional Testing

- [ ] Email/password login works
- [ ] Google login works
- [ ] Facebook login works
- [ ] Facebook Page connect works
- [ ] Google Drive connect works
- [ ] AI content generation works
- [ ] Create post works
- [ ] Schedule works
- [ ] Cron endpoint works

## 7. Final Checks

- [ ] `/privacy-policy` is accessible
- [ ] Tokens are stored securely
- [ ] Domain is connected
- [ ] SSL is active
