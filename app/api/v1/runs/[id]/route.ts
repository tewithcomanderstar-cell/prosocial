import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { WorkflowRunService } from '@/src/modules/workflow-runs/workflow-run.service';
import { runIdParamsSchema } from '@/src/modules/workflow-runs/workflow-run.schemas';

const service = new WorkflowRunService();
export const GET = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(runIdParamsSchema, await contextData.params);
  return apiOk(await service.getRunById(context, params.id));
});
