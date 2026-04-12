export type DestinationValidationResult = {
  isValid: boolean;
  reason?: string;
  retryable?: boolean;
};

export type PayloadValidationResult = {
  isValid: boolean;
  errors?: string[];
};

export type PublishProviderPayload = {
  title?: string | null;
  bodyText?: string | null;
  media: Array<{ publicUrl: string; type: string; mimeType: string }>;
  platformPayload?: unknown;
};

export type PublishProviderResult = {
  success: boolean;
  externalPostId?: string;
  rawResponse?: unknown;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  rateLimitResetAt?: Date;
};

export interface PlatformPublisher {
  readonly platformKey: string;
  validateDestination(input: { destination: unknown; credential: unknown }): Promise<DestinationValidationResult>;
  validatePayload(input: { destination: unknown; payload: PublishProviderPayload }): Promise<PayloadValidationResult>;
  publish(input: { destination: unknown; credential: unknown; payload: PublishProviderPayload; correlationId: string }): Promise<PublishProviderResult>;
  getPost?(input: { destination: unknown; credential: unknown; externalPostId: string; correlationId: string }): Promise<unknown>;
  deletePost?(input: { destination: unknown; credential: unknown; externalPostId: string; correlationId: string }): Promise<unknown>;
}
