import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { WorkflowService } from '@/src/modules/workflows/workflow.service';
import { workflowIdParamsSchema, updateWorkflowSchema } from '@/src/modules/workflows/workflow.schemas';

const service = new WorkflowService();

export const GET = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(workflowIdParamsSchema, await contextData.params);
  return apiOk(await service.getWorkflowById(context, params.id));
});

export const PATCH = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(workflowIdParamsSchema, await contextData.params);
  const body = parseOrThrow(updateWorkflowSchema, await request.json());
  return apiOk(await service.updateWorkflow(context, params.id, body));
});
