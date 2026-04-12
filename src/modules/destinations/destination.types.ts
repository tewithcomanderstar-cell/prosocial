export type DestinationDto = {
  id: string;
  workspaceId: string;
  platformId: string;
  accountId: string;
  externalId: string;
  type: string;
  name: string;
  status: string;
  permissionsJson: unknown;
  metadataJson: unknown;
  isPaused: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type DestinationSyncResultDto = {
  requestedAccountIds: string[];
  platformId?: string;
  accepted: true;
  syncQueued: true;
};
