import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { MediaService } from '@/src/modules/media/media.service';
import { createMediaSchema, mediaIdParamsSchema } from '@/src/modules/media/media.schemas';

const service = new MediaService();

export const POST = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const body = parseOrThrow(createMediaSchema, await request.json());
  return apiOk(await service.uploadMedia(context, body), { status: 201 });
});
