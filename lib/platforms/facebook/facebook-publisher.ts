import type { Destination, WorkflowRun } from '@/lib/domain/types';
import type { ConnectionHealthResult, PlatformPublisher, PublishPayload, PublishResult } from '@/lib/platforms/publisher';

export interface FacebookPublishClient {
  publishPhoto(input: {
    pageId: string;
    accessToken: string;
    caption: string;
    mediaUrl?: string;
  }): Promise<{ id?: string; statusCode?: number; raw?: Record<string, unknown> }>;
}

export interface FacebookDestinationMetadata {
  pageAccessToken?: string;
  lastSuccessfulPublishAt?: string;
}

export class FacebookPublisher implements PlatformPublisher {
  readonly platformKey = 'facebook';

  constructor(private readonly client: FacebookPublishClient) {}

  async validateDestination(destination: Destination): Promise<ConnectionHealthResult> {
    const permissions = destination.permissionsJson ?? {};
    const tokenStatus = permissions['tokenStatus'] === 'expired' ? 'expired' : 'valid';
    const permissionStatus = permissions['canPublish'] === false ? 'invalid' : 'valid';

    return {
      destinationId: destination.id,
      connectionStatus: tokenStatus === 'expired' ? 'warning' : 'healthy',
      permissionStatus,
      tokenStatus,
      warnings: permissionStatus === 'invalid' ? ['Destination is missing publish permissions'] : [],
      lastValidatedAt: new Date().toISOString(),
    };
  }

  async publish(destination: Destination, payload: PublishPayload): Promise<PublishResult> {
    const metadata = (destination.permissionsJson ?? {}) as FacebookDestinationMetadata;

    if (!metadata.pageAccessToken) {
      return {
        success: false,
        errorCode: 'facebook_missing_access_token',
        errorMessage: 'Facebook page access token is missing for this destination.',
      };
    }

    const response = await this.client.publishPhoto({
      pageId: destination.externalDestinationId,
      accessToken: metadata.pageAccessToken,
      caption: payload.bodyText,
      mediaUrl: payload.mediaUrls?.[0],
    });

    const publishedAt = new Date().toISOString();

    if (!response.id && response.statusCode && response.statusCode >= 400) {
      return {
        success: false,
        errorCode: 'facebook_publish_failed',
        errorMessage: 'Facebook publish request failed.',
        rawResponse: response.raw,
      };
    }

    return {
      success: true,
      externalPostId: response.id,
      rawResponse: response.raw,
      publishedAt,
    };
  }

  async retryPublish(_run: WorkflowRun, destination: Destination, payload: PublishPayload): Promise<PublishResult> {
    return this.publish(destination, payload);
  }
}
