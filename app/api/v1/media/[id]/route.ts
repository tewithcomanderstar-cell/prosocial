import { NextRequest } from 'next/server';
import { apiNoContent, apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { MediaService } from '@/src/modules/media/media.service';
import { mediaIdParamsSchema } from '@/src/modules/media/media.schemas';

const service = new MediaService();

export const GET = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(mediaIdParamsSchema, await contextData.params);
  return apiOk(await service.getMediaById(context, params.id));
});

export const DELETE = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(mediaIdParamsSchema, await contextData.params);
  await service.deleteMedia(context, params.id);
  return apiNoContent();
});
