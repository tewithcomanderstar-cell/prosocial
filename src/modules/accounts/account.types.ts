export type AccountDto = {
  id: string;
  workspaceId: string;
  platformId: string;
  providerAccountId: string;
  displayName: string;
  status: string;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type AccountValidationResultDto = {
  accountId: string;
  status: 'ok' | 'warning';
  credentialStatus: string | null;
  expiresAt: Date | null;
  scopes: unknown;
};
