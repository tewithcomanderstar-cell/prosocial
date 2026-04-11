import { prisma } from '@/src/lib/db/prisma';
import { ConflictError, InvariantViolationError, NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import { SettingsService } from '@/src/modules/settings/settings.service';
import { PublishingOrchestratorService } from '@/src/modules/publishing/publishing-orchestrator.service';
import type { ContentItemDto } from './content.types';

function toContentDto(record: Awaited<ReturnType<typeof prisma.contentItem.findFirstOrThrow>> & { contentDestinations?: Array<any>; mediaAssets?: Array<any> }): ContentItemDto {
  return {
    ...record,
    destinations: (record.contentDestinations ?? []).map((item) => ({
      id: item.id,
      destinationId: item.destinationId,
      publishStatus: item.publishStatus,
      scheduledAt: item.scheduledAt,
      publishedAt: item.publishedAt,
      externalPostId: item.externalPostId,
      lastError: item.lastError,
      platformPayloadJson: item.platformPayloadJson,
    })),
    mediaAssetIds: (record.mediaAssets ?? []).map((item) => item.id),
  };
}

export class ContentService {
  constructor(
    private readonly settingsService = new SettingsService(),
    private readonly publishingService = new PublishingOrchestratorService()
  ) {}

  async listContent(context: RequestContext, filters: { status?: string; reviewStatus?: string; publishStatus?: string; destinationId?: string; take: number }): Promise<ContentItemDto[]> {
    const rows = await prisma.contentItem.findMany({
      where: {
        workspaceId: context.workspaceId,
        status: filters.status as never,
        reviewStatus: filters.reviewStatus as never,
        publishStatus: filters.publishStatus as never,
        contentDestinations: filters.destinationId ? { some: { destinationId: filters.destinationId } } : undefined,
      },
      include: { contentDestinations: true, mediaAssets: true },
      take: filters.take,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => toContentDto(row as any));
  }

  async getContentById(context: RequestContext, id: string): Promise<ContentItemDto> {
    const row = await prisma.contentItem.findFirst({
      where: { id, workspaceId: context.workspaceId },
      include: { contentDestinations: true, mediaAssets: true },
    });
    if (!row) throw new NotFoundError('Content item not found');
    return toContentDto(row as any);
  }

  async createContent(context: RequestContext, input: { title?: string | null; bodyText?: string | null; sourceType?: string | null; sourceRef?: string | null; metadataJson?: unknown; destinationAssignments: Array<{ destinationId: string; scheduledAt?: Date; platformPayloadJson?: unknown }>; mediaAssetIds: string[]; }): Promise<ContentItemDto> {
    const record = await prisma.contentItem.create({
      data: {
        workspaceId: context.workspaceId,
        title: input.title ?? null,
        bodyText: input.bodyText ?? null,
        sourceType: input.sourceType ?? null,
        sourceRef: input.sourceRef ?? null,
        metadataJson: input.metadataJson,
        createdById: context.userId,
        updatedById: context.userId,
        contentDestinations: input.destinationAssignments.length
          ? {
              create: input.destinationAssignments.map((assignment) => ({
                destinationId: assignment.destinationId,
                scheduledAt: assignment.scheduledAt,
                platformPayloadJson: assignment.platformPayloadJson,
              })),
            }
          : undefined,
        mediaAssets: input.mediaAssetIds.length
          ? {
              connect: input.mediaAssetIds.map((id) => ({ id })),
            }
          : undefined,
      },
      include: { contentDestinations: true, mediaAssets: true },
    });

    return toContentDto(record as any);
  }

  async updateContent(context: RequestContext, id: string, input: { title?: string | null; bodyText?: string | null; metadataJson?: unknown; destinationAssignments?: Array<{ destinationId: string; scheduledAt?: Date; platformPayloadJson?: unknown }>; mediaAssetIds?: string[]; }): Promise<ContentItemDto> {
    await this.getContentById(context, id);

    if (input.destinationAssignments) {
      await prisma.contentDestination.deleteMany({ where: { contentItemId: id } });
      if (input.destinationAssignments.length) {
        await prisma.contentDestination.createMany({
          data: input.destinationAssignments.map((assignment) => ({
            contentItemId: id,
            destinationId: assignment.destinationId,
            scheduledAt: assignment.scheduledAt,
            platformPayloadJson: assignment.platformPayloadJson,
          })),
        });
      }
    }

    if (input.mediaAssetIds) {
      await prisma.mediaAsset.updateMany({ where: { contentItemId: id }, data: { contentItemId: null } });
      if (input.mediaAssetIds.length) {
        await prisma.mediaAsset.updateMany({ where: { id: { in: input.mediaAssetIds }, workspaceId: context.workspaceId }, data: { contentItemId: id } });
      }
    }

    const record = await prisma.contentItem.update({
      where: { id },
      data: {
        title: input.title,
        bodyText: input.bodyText,
        metadataJson: input.metadataJson,
        updatedById: context.userId,
      },
      include: { contentDestinations: true, mediaAssets: true },
    });
    return toContentDto(record as any);
  }

  async deleteContent(context: RequestContext, id: string): Promise<void> {
    const item = await this.getContentById(context, id);
    if (item.publishStatus === 'publishing') {
      throw new ConflictError('Publishing content cannot be deleted');
    }
    await prisma.contentItem.delete({ where: { id } });
  }

  async duplicateContent(context: RequestContext, id: string): Promise<ContentItemDto> {
    const item = await this.getContentById(context, id);
    return this.createContent(context, {
      title: item.title,
      bodyText: item.bodyText,
      sourceType: item.sourceType,
      sourceRef: item.sourceRef,
      metadataJson: item.metadataJson,
      destinationAssignments: item.destinations.map((destination) => ({
        destinationId: destination.destinationId,
        platformPayloadJson: destination.platformPayloadJson,
      })),
      mediaAssetIds: item.mediaAssetIds,
    });
  }

  async submitForReview(context: RequestContext, id: string, input: { comment?: string; assignedToId?: string }): Promise<ContentItemDto> {
    const item = await this.getContentById(context, id);
    if (item.reviewStatus === 'approved') {
      throw new ConflictError('Approved content cannot be resubmitted without edits');
    }

    await prisma.approvalRequest.create({
      data: {
        workspaceId: context.workspaceId,
        contentItemId: id,
        requestedById: context.userId,
        assignedToId: input.assignedToId,
        comment: input.comment,
      },
    });

    const record = await prisma.contentItem.update({
      where: { id },
      data: { status: 'pending_review', reviewStatus: 'pending', updatedById: context.userId },
      include: { contentDestinations: true, mediaAssets: true },
    });
    return toContentDto(record as any);
  }

  async approveContent(context: RequestContext, id: string, input: { comment?: string }): Promise<ContentItemDto> {
    await this.getContentById(context, id);
    await prisma.approvalRequest.updateMany({
      where: { contentItemId: id, workspaceId: context.workspaceId, status: 'pending' },
      data: { status: 'approved', decision: 'approved', comment: input.comment, decidedAt: new Date() },
    });
    const record = await prisma.contentItem.update({
      where: { id },
      data: { status: 'approved', reviewStatus: 'approved', updatedById: context.userId },
      include: { contentDestinations: true, mediaAssets: true },
    });
    return toContentDto(record as any);
  }

  async rejectContent(context: RequestContext, id: string, input: { comment: string }): Promise<ContentItemDto> {
    await this.getContentById(context, id);
    await prisma.approvalRequest.updateMany({
      where: { contentItemId: id, workspaceId: context.workspaceId, status: 'pending' },
      data: { status: 'rejected', decision: 'rejected', comment: input.comment, decidedAt: new Date() },
    });
    const record = await prisma.contentItem.update({
      where: { id },
      data: { status: 'draft', reviewStatus: 'rejected', publishStatus: 'not_scheduled', updatedById: context.userId },
      include: { contentDestinations: true, mediaAssets: true },
    });
    return toContentDto(record as any);
  }

  async scheduleContent(context: RequestContext, id: string, input: { scheduledAt: Date; destinationIds?: string[] }): Promise<ContentItemDto> {
    const item = await this.getContentById(context, id);
    const targetDestinationIds = input.destinationIds ?? item.destinations.map((destination) => destination.destinationId);
    if (!targetDestinationIds.length) {
      throw new InvariantViolationError('Scheduling requires at least one destination');
    }

    await prisma.contentDestination.updateMany({
      where: { contentItemId: id, destinationId: { in: targetDestinationIds } },
      data: { publishStatus: 'queued', scheduledAt: input.scheduledAt },
    });

    const record = await prisma.contentItem.update({
      where: { id },
      data: { status: 'scheduled', publishStatus: 'queued', scheduledAt: input.scheduledAt, updatedById: context.userId },
      include: { contentDestinations: true, mediaAssets: true },
    });
    return toContentDto(record as any);
  }

  async publishNow(context: RequestContext, id: string): Promise<{ accepted: true; workflowRunId: string; publishJobIds: string[] }> {
    const item = await this.getContentById(context, id);
    const settings = await this.settingsService.getSettings(context);
    if (settings.approvalRequired && item.reviewStatus !== 'approved') {
      throw new InvariantViolationError('Approval is required before publish-now');
    }

    const result = await this.publishingService.publishNow({
      workspaceId: context.workspaceId,
      contentItemId: id,
      requestedById: context.userId,
      idempotencyKey: context.idempotencyKey,
    });

    return result;
  }
}
