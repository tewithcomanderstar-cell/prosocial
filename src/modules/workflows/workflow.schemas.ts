import { z } from 'zod';

const workflowStepSchema = z.object({
  stepOrder: z.number().int().min(0),
  stepType: z.string().min(1).max(80),
  stepKey: z.string().min(1).max(80),
  configJson: z.unknown().optional(),
});

function hasDuplicateStepOrder(steps: Array<{ stepOrder: number }>) {
  return new Set(steps.map((step) => step.stepOrder)).size !== steps.length;
}

export const workflowIdParamsSchema = z.object({ id: z.string().cuid() });

export const createWorkflowSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  triggerType: z.string().min(1).max(80),
  configJson: z.unknown().optional(),
  steps: z.array(workflowStepSchema).min(1),
}).superRefine((value, ctx) => {
  if (hasDuplicateStepOrder(value.steps)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Workflow steps must use unique stepOrder values' });
  }
});

export const updateWorkflowSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  triggerType: z.string().min(1).max(80).optional(),
  configJson: z.unknown().optional(),
  steps: z.array(workflowStepSchema).min(1).optional(),
}).superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field must be provided' });
  }
  if (value.steps && hasDuplicateStepOrder(value.steps)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Workflow steps must use unique stepOrder values' });
  }
});

export const listWorkflowsQuerySchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
});

export const testRunWorkflowSchema = z.object({
  inputJson: z.unknown().optional(),
  contextJson: z.unknown().optional(),
  contentItemId: z.string().cuid().optional(),
});
