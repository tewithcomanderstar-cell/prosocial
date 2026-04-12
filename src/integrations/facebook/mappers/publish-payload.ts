import type { PublishProviderPayload } from '@/src/modules/publishing/platform-publisher';

export function mapNormalizedContentToFacebookPayload(payload: PublishProviderPayload) {
  return {
    message: payload.bodyText ?? payload.title ?? '',
    media: payload.media,
    providerMetadata: payload.platformPayload ?? null,
  };
}
