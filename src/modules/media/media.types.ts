export type MediaAssetDto = {
  id: string;
  workspaceId: string;
  contentItemId: string | null;
  type: string;
  storageKey: string;
  publicUrl: string;
  mimeType: string;
  sizeBytes: bigint;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  checksum: string | null;
  processingStatus: string;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};
