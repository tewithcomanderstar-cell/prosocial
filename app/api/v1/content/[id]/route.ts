import { NextRequest } from 'next/server';
import { apiNoContent, apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { ContentService } from '@/src/modules/content/content.service';
import { contentIdParamsSchema, updateContentSchema } from '@/src/modules/content/content.schemas';

const service = new ContentService();

export const GET = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(contentIdParamsSchema, await contextData.params);
  return apiOk(await service.getContentById(context, params.id));
});

export const PATCH = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(contentIdParamsSchema, await contextData.params);
  const body = parseOrThrow(updateContentSchema, await request.json());
  return apiOk(await service.updateContent(context, params.id, body));
});

export const DELETE = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(contentIdParamsSchema, await contextData.params);
  await service.deleteContent(context, params.id);
  return apiNoContent();
});
