export type ValidateCredentialJob = {
  workspaceId: string;
  credentialId: string;
  accountId?: string;
  correlationId: string;
};

export type RefreshDestinationMetadataJob = {
  workspaceId: string;
  destinationId: string;
  accountId?: string;
  correlationId: string;
};

export type DetectStuckRunsJob = {
  workspaceId?: string;
  runOlderThanMinutes: number;
  correlationId: string;
};

export type ArchiveOldLogsJob = {
  workspaceId?: string;
  retentionDays: number;
  correlationId: string;
};

export type RequeueRetryablePublishJobsJob = {
  workspaceId?: string;
  dueBefore: string;
  correlationId: string;
};
