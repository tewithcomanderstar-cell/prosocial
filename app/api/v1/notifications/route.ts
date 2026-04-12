import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { NotificationService } from '@/src/modules/notifications/notification.service';
import { listNotificationsQuerySchema } from '@/src/modules/notifications/notification.schemas';

const service = new NotificationService();
export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const query = parseOrThrow(listNotificationsQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));
  return apiOk(await service.listNotifications(context, query));
});
