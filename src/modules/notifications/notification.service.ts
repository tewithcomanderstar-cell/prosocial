import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { NotificationDto } from './notification.types';

export class NotificationService {
  async listNotifications(context: RequestContext, filters: { status?: string; channel?: string; unreadOnly?: string }): Promise<NotificationDto[]> {
    return prisma.notification.findMany({
      where: {
        workspaceId: context.workspaceId,
        OR: [{ userId: context.userId }, { userId: null }],
        status: filters.status as never,
        channel: filters.channel as never,
        readAt: filters.unreadOnly === 'true' ? null : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markAsRead(context: RequestContext, id: string): Promise<NotificationDto> {
    const notification = await prisma.notification.findFirst({
      where: { id, workspaceId: context.workspaceId, OR: [{ userId: context.userId }, { userId: null }] },
    });
    if (!notification) throw new NotFoundError('Notification not found');
    return prisma.notification.update({ where: { id }, data: { status: 'read', readAt: new Date() } });
  }
}
