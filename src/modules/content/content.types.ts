export type ContentDestinationAssignmentDto = {
  id: string;
  destinationId: string;
  publishStatus: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  externalPostId: string | null;
  lastError: string | null;
  platformPayloadJson: unknown;
};

export type ContentItemDto = {
  id: string;
  workspaceId: string;
  title: string | null;
  bodyText: string | null;
  status: string;
  reviewStatus: string;
  publishStatus: string;
  sourceType: string | null;
  sourceRef: string | null;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  createdById: string;
  updatedById: string | null;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  destinations: ContentDestinationAssignmentDto[];
  mediaAssetIds: string[];
};
