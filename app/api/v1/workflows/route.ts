import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { WorkflowService } from '@/src/modules/workflows/workflow.service';
import { createWorkflowSchema, listWorkflowsQuerySchema } from '@/src/modules/workflows/workflow.schemas';

const service = new WorkflowService();

export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const query = parseOrThrow(listWorkflowsQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));
  return apiOk(await service.listWorkflows(context, query));
});

export const POST = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const body = parseOrThrow(createWorkflowSchema, await request.json());
  return apiOk(await service.createWorkflow(context, body), { status: 201 });
});
