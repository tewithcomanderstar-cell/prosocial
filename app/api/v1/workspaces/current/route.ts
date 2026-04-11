import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { WorkspaceService } from '@/src/modules/workspaces/workspace.service';
import { updateWorkspaceSchema } from '@/src/modules/workspaces/workspace.schemas';

const service = new WorkspaceService();

export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  return apiOk(await service.getCurrentWorkspace(context));
});

export const PATCH = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const body = parseOrThrow(updateWorkspaceSchema, await request.json());
  return apiOk(await service.updateCurrentWorkspace(context, body));
});
