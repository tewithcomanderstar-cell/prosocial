import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { DestinationDto, DestinationSyncResultDto } from './destination.types';

export class DestinationService {
  async listDestinations(context: RequestContext, filters: { platformId?: string; accountId?: string; status?: string; isPaused?: string }): Promise<DestinationDto[]> {
    return prisma.destination.findMany({
      where: {
        workspaceId: context.workspaceId,
        platformId: filters.platformId,
        accountId: filters.accountId,
        status: filters.status as never,
        isPaused: filters.isPaused ? filters.isPaused === 'true' : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDestinationById(context: RequestContext, id: string): Promise<DestinationDto> {
    const destination = await prisma.destination.findFirst({ where: { id, workspaceId: context.workspaceId } });
    if (!destination) throw new NotFoundError('Destination not found');
    return destination;
  }

  async updateDestination(context: RequestContext, id: string, input: Record<string, unknown>): Promise<DestinationDto> {
    await this.getDestinationById(context, id);
    return prisma.destination.update({ where: { id }, data: input });
  }

  async pauseDestination(context: RequestContext, id: string): Promise<DestinationDto> {
    return this.updateDestination(context, id, { isPaused: true });
  }

  async resumeDestination(context: RequestContext, id: string): Promise<DestinationDto> {
    return this.updateDestination(context, id, { isPaused: false });
  }

  async syncDestinations(context: RequestContext, input: { platformId?: string; accountIds?: string[] }): Promise<DestinationSyncResultDto> {
    return {
      requestedAccountIds: input.accountIds ?? [],
      platformId: input.platformId,
      accepted: true,
      syncQueued: true,
    };
  }
}
