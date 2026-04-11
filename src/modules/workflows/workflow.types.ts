export type WorkflowStepDto = {
  id: string;
  stepOrder: number;
  stepType: string;
  stepKey: string;
  configJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowDto = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: string;
  triggerType: string;
  version: number;
  configJson: unknown;
  createdById: string;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  steps: WorkflowStepDto[];
};
