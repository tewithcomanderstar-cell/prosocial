import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { WorkflowRunService } from '@/src/modules/workflow-runs/workflow-run.service';
import { listRunsQuerySchema } from '@/src/modules/workflow-runs/workflow-run.schemas';

const service = new WorkflowRunService();
export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const query = parseOrThrow(listRunsQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));
  return apiOk(await service.listRuns(context, query));
});
