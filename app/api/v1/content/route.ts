import { NextRequest } from 'next/server';
import { apiOk, apiNoContent, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { ContentService } from '@/src/modules/content/content.service';
import { createContentSchema, listContentQuerySchema } from '@/src/modules/content/content.schemas';

const service = new ContentService();

export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const query = parseOrThrow(listContentQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));
  return apiOk(await service.listContent(context, query));
});

export const POST = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const body = parseOrThrow(createContentSchema, await request.json());
  return apiOk(await service.createContent(context, body), { status: 201 });
});
