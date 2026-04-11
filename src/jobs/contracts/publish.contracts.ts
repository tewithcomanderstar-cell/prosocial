export type PublishErrorKind =
  | 'validation_error'
  | 'auth_error'
  | 'permission_error'
  | 'provider_error_transient'
  | 'provider_error_permanent'
  | 'rate_limit_error'
  | 'conflict_error'
  | 'invariant_violation'
  | 'internal_error';

export type PublishContentDestinationJob = {
  workspaceId: string;
  contentDestinationId: string;
  workflowRunId?: string;
  publishIntentKey: string;
  requestedById?: string;
  correlationId: string;
};

export type RetryPublishContentDestinationJob = PublishContentDestinationJob & {
  priorPublishJobId: string;
  retryReason: PublishErrorKind;
};
