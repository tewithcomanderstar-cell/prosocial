import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { SettingsService } from '@/src/modules/settings/settings.service';
import { settingsUpdateSchema } from '@/src/modules/settings/settings.schemas';

const service = new SettingsService();

export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  return apiOk(await service.getSettings(context));
});

export const PATCH = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const body = parseOrThrow(settingsUpdateSchema, await request.json());
  return apiOk(await service.updateSettings(context, body));
});
