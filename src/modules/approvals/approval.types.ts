export type ApprovalRequestDto = {
  id: string;
  workspaceId: string;
  contentItemId: string;
  requestedById: string;
  assignedToId: string | null;
  status: string;
  decision: string | null;
  comment: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
