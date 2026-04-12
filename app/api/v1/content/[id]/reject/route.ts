import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { ContentService } from '@/src/modules/content/content.service';
import { contentIdParamsSchema, rejectionSchema } from '@/src/modules/content/content.schemas';

const service = new ContentService();
export const POST = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(contentIdParamsSchema, await contextData.params);
  const body = parseOrThrow(rejectionSchema, await request.json());
  return apiOk(await service.rejectContent(context, params.id, body));
});
