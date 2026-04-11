import { FacebookApiClient } from '@/src/integrations/facebook/api-client/facebook-api-client';
import { mapNormalizedContentToFacebookPayload } from '@/src/integrations/facebook/mappers/publish-payload';
import { validateFacebookPublishPayload } from '@/src/integrations/facebook/validators/publish-payload';
import type { DestinationValidationResult, PayloadValidationResult, PlatformPublisher, PublishProviderPayload, PublishProviderResult } from '@/src/modules/publishing/platform-publisher';

export class FacebookPublisher implements PlatformPublisher {
  readonly platformKey = 'facebook';

  constructor(private readonly client = new FacebookApiClient()) {}

  async validateDestination(input: { destination: any; credential: any }): Promise<DestinationValidationResult> {
    if (!input.destination?.externalId) {
      return { isValid: false, reason: 'Destination externalId is missing.', retryable: false };
    }
    if (!input.credential?.accessTokenEncrypted) {
      return { isValid: false, reason: 'Credential is missing.', retryable: false };
    }
    if (input.destination?.isPaused) {
      return { isValid: false, reason: 'Destination is paused.', retryable: false };
    }
    return { isValid: true };
  }

  async validatePayload(input: { destination: any; payload: PublishProviderPayload }): Promise<PayloadValidationResult> {
    return validateFacebookPublishPayload(input.payload);
  }

  async publish(input: { destination: any; credential: any; payload: PublishProviderPayload; correlationId: string }): Promise<PublishProviderResult> {
    const mapped = mapNormalizedContentToFacebookPayload(input.payload);
    void mapped;
    void input;
    throw new Error('FacebookPublisher.publish is intentionally deferred to provider execution phase');
  }
}
