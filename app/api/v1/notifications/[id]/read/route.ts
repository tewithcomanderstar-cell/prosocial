import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { NotificationService } from '@/src/modules/notifications/notification.service';
import { notificationIdParamsSchema } from '@/src/modules/notifications/notification.schemas';

const service = new NotificationService();
export const POST = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(notificationIdParamsSchema, await contextData.params);
  return apiOk(await service.markAsRead(context, params.id));
});
