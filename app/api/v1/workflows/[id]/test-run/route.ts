import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { WorkflowService } from '@/src/modules/workflows/workflow.service';
import { workflowIdParamsSchema, testRunWorkflowSchema } from '@/src/modules/workflows/workflow.schemas';

const service = new WorkflowService();
export const POST = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(workflowIdParamsSchema, await contextData.params);
  const body = parseOrThrow(testRunWorkflowSchema, await request.json());
  return apiOk(await service.testRunWorkflow(context, params.id, body), { status: 202 });
});
