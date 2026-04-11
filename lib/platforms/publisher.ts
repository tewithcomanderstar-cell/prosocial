import type { Destination, WorkflowRun } from '@/lib/domain/types';

export interface PublishPayload {
  contentItemId: string;
  title?: string;
  bodyText: string;
  mediaUrls?: string[];
  scheduledAt?: string;
  platformPayload?: Record<string, unknown>;
}

export interface PublishResult {
  success: boolean;
  externalPostId?: string;
  rawResponse?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  publishedAt?: string;
}

export interface ConnectionHealthResult {
  destinationId: string;
  connectionStatus: 'healthy' | 'warning' | 'broken';
  permissionStatus: 'valid' | 'partial' | 'invalid';
  tokenStatus: 'valid' | 'expiring' | 'expired';
  warnings: string[];
  lastValidatedAt: string;
}

export interface PlatformPublisher {
  readonly platformKey: string;
  validateDestination(destination: Destination): Promise<ConnectionHealthResult>;
  publish(destination: Destination, payload: PublishPayload): Promise<PublishResult>;
  retryPublish(run: WorkflowRun, destination: Destination, payload: PublishPayload): Promise<PublishResult>;
}
