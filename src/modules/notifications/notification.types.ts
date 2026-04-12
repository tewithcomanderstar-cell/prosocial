export type NotificationDto = {
  id: string;
  workspaceId: string;
  userId: string | null;
  type: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  payloadJson: unknown;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
