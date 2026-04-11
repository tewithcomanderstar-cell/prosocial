import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { DestinationService } from '@/src/modules/destinations/destination.service';
import { syncDestinationsSchema } from '@/src/modules/destinations/destination.schemas';

const service = new DestinationService();
export const POST = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const body = parseOrThrow(syncDestinationsSchema, await request.json());
  return apiOk(await service.syncDestinations(context, body), { status: 202 });
});
