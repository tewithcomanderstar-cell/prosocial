import { createHmac, timingSafeEqual } from 'crypto';

export function verifyFacebookWebhookSignature(rawBody: string, signatureHeader: string | null, appSecret: string) {
  if (!signatureHeader) return false;
  const [prefix, signature] = signatureHeader.split('=');
  if (prefix !== 'sha256' || !signature) return false;
  const digest = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}
