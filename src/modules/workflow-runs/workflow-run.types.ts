export type WorkflowRunDto = {
  id: string;
  workspaceId: string;
  workflowId: string;
  contentItemId: string | null;
  triggerType: string;
  triggerSource: string | null;
  triggerEventId: string | null;
  status: string;
  inputJson: unknown;
  contextJson: unknown;
  outputJson: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
