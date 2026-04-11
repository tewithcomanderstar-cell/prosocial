import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { DestinationService } from '@/src/modules/destinations/destination.service';
import { listDestinationsQuerySchema } from '@/src/modules/destinations/destination.schemas';

const service = new DestinationService();
export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const query = parseOrThrow(listDestinationsQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));
  return apiOk(await service.listDestinations(context, query));
});
