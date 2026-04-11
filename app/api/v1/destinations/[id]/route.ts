import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { DestinationService } from '@/src/modules/destinations/destination.service';
import { destinationIdParamsSchema, updateDestinationSchema } from '@/src/modules/destinations/destination.schemas';

const service = new DestinationService();

export const GET = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(destinationIdParamsSchema, await contextData.params);
  return apiOk(await service.getDestinationById(context, params.id));
});

export const PATCH = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(destinationIdParamsSchema, await contextData.params);
  const body = parseOrThrow(updateDestinationSchema, await request.json());
  return apiOk(await service.updateDestination(context, params.id, body));
});
