import type { PublishProviderPayload, PayloadValidationResult } from '@/src/modules/publishing/platform-publisher';

export function validateFacebookPublishPayload(payload: PublishProviderPayload): PayloadValidationResult {
  const errors: string[] = [];
  if (!payload.bodyText && !payload.title) {
    errors.push('Facebook publish payload requires title or body text.');
  }
  if (!payload.media.length) {
    errors.push('At least one media asset is required for Facebook publish flow.');
  }
  return { isValid: errors.length === 0, errors: errors.length ? errors : undefined };
}
