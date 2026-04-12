import { prisma } from '@/src/lib/db/prisma';
import { ConflictError, InvalidStateTransitionError, NotFoundError, PolicyViolationError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import { AuditLogService } from '@/src/modules/audit/audit.service';
import { SettingsService } from '@/src/modules/settings/settings.service';
import { PublishingOrchestratorService } from '@/src/modules/publishing/publishing-orchestrator.service';
import { assertPermission } from '@/src/modules/rbac/assert';
import { permissions } from '@/src/modules/rbac/permissions';
import { ensureApprovalActionAllowed, ensureContentNotArchivedOrPublished, ensureContentReadyForReview, ensurePublishAllowed, ensureScheduleAllowed, requireApprovalForContent } from '@/src/modules/rbac/policy';
import type { ContentItemDto } from './content.types';

function toContentDto(record: Awaited<ReturnType<typeof prisma.contentItem.findFirstOrThrow>> & { contentDestinations?: Array<any>; mediaAssets?: Array<any> }): ContentItemDto {
  return {
    ...record,
    destinations: (record.contentDestinations ?? []).map((item: NonNullable<typeof record.contentDestinations>[number]) => ({
      id: item.id,
      destinationId: item.destinationId,
      publishStatus: item.publishStatus,
      scheduledAt: item.scheduledAt,
      publishedAt: item.publishedAt,
      externalPostId: item.externalPostId,
      lastError: item.lastError,
      platformPayloadJson: item.platformPayloadJson,
    })),
    mediaAssetIds: (record.mediaAssets ?? []).map((item: NonNullable<typeof record.mediaAssets>[number]) => item.id),
  };
}

export class ContentService {
  constructor(
    private readonly settingsService = new SettingsService(),
    private readonly publishingService = new PublishingOrchestratorService(),
    private readonly auditLogService = new AuditLogService()
  ) {}

  async listContent(context: RequestContext, filters: { status?: string; reviewStatus?: string; publishStatus?: string; destinationId?: string; take?: number }): Promise<ContentItemDto[]> {
    await assertPermission(context, permissions.contentRead);
    const rows = await prisma.contentItem.findMany({
      where: {
        workspaceId: context.workspaceId,
        status: filters.status as never,
        reviewStatus: filters.reviewStatus as never,
        publishStatus: filters.publishStatus as never,
        contentDestinations: filters.destinationId ? { some: { destinationId: filters.destinationId } } : undefined,
      },
      include: { contentDestinations: true, mediaAssets: true },
      take: filters.take ?? 50,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row: typeof rows[number]) => toContentDto(row as any));
  }

  async getContentById(context: RequestContext, id: string): Promise<ContentItemDto> {
    await assertPermission(context, permissions.contentRead);
    const row = await prisma.contentItem.findFirst({
      where: { id, workspaceId: context.workspaceId },
      include: { contentDestinations: true, mediaAssets: true },
    });
    if (!row) throw new NotFoundError('Content item not found');
    return toContentDto(row as any);
  }

  async createContent(context: RequestContext, input: { title?: string | null; bodyText?: string | null; sourceType?: string | null; sourceRef?: string | null; metadataJson?: unknown; destinationAssignments?: Array<{ destinationId: string; scheduledAt?: Date; platformPayloadJson?: unknown }>; mediaAssetIds?: string[]; }): Promise<ContentItemDto> {
    const authorized = await assertPermission(context, permissions.contentCreate);
    const destinationAssignments = input.destinationAssignments ?? [];
    const mediaAssetIds = input.mediaAssetIds ?? [];
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
        contentDestinations: destinationAssignments.length
          ? {
              create: destinationAssignments.map((assignment) => ({
                destinationId: assignment.destinationId,
                scheduledAt: assignment.scheduledAt,
                platformPayloadJson: assignment.platformPayloadJson,
              })),
            }
          : undefined,
        mediaAssets: mediaAssetIds.length
          ? {
              connect: mediaAssetIds.map((id) => ({ id })),
            }
          : undefined,
      },
      include: { contentDestinations: true, mediaAssets: true },
    });

    await this.auditLogService.recordContentAction(authorized, {
        action: 'content.created',
        contentItemId: record.id,
        metadataJson: {
        destinationCount: destinationAssignments.length,
        mediaAssetIds,
      },
    });

    return toContentDto(record as any);
  }

  async updateContent(context: RequestContext, id: string, input: { title?: string | null; bodyText?: string | null; metadataJson?: unknown; destinationAssignments?: Array<{ destinationId: string; scheduledAt?: Date; platformPayloadJson?: unknown }>; mediaAssetIds?: string[]; }): Promise<ContentItemDto> {
    const authorized = await assertPermission(context, permissions.contentUpdate);
    const existing = await this.getContentById(context, id);
    ensureContentNotArchivedOrPublished(existing);
    if (existing.publishStatus === 'publishing') {
      throw new InvalidStateTransitionError('Publishing content cannot be modified');
    }

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

    await this.auditLogService.recordContentAction(authorized, {
      action: 'content.updated',
      contentItemId: id,
      metadataJson: {
        updatedFields: Object.keys(input),
      },
    });

    return toContentDto(record as any);
  }

  async deleteContent(context: RequestContext, id: string): Promise<void> {
    const authorized = await assertPermission(context, permissions.contentDelete);
    const item = await this.getContentById(context, id);
    if (item.publishStatus === 'publishing') {
      throw new ConflictError('Publishing content cannot be deleted');
    }
    if (item.status === 'published') {
      throw new InvalidStateTransitionError('Published content cannot be deleted');
    }
    await prisma.contentItem.delete({ where: { id } });
    await this.auditLogService.recordContentAction(authorized, {
      action: 'content.deleted',
      contentItemId: id,
      metadataJson: {
        previousStatus: item.status,
      },
    });
  }

  async duplicateContent(context: RequestContext, id: string): Promise<ContentItemDto> {
    await assertPermission(context, permissions.contentCreate);
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
    const authorized = await assertPermission(context, permissions.contentSubmitReview);
    const item = await this.getContentById(context, id);
    ensureContentReadyForReview(item);

    const existingPending = await prisma.approvalRequest.findFirst({
      where: { workspaceId: context.workspaceId, contentItemId: id, status: 'pending' },
    });

    const approvalRequest = existingPending
      ? await prisma.approvalRequest.update({
          where: { id: existingPending.id },
          data: {
            assignedToId: input.assignedToId ?? existingPending.assignedToId,
            comment: input.comment ?? existingPending.comment,
            requestedById: context.userId,
          },
        })
      : await prisma.approvalRequest.create({
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

    await this.auditLogService.recordApprovalDecision(authorized, {
      action: 'content.submit_review',
      approvalRequestId: approvalRequest.id,
      contentItemId: id,
      comment: input.comment ?? null,
      metadataJson: { assignedToId: input.assignedToId ?? null },
    });

    return toContentDto(record as any);
  }

  async approveContent(context: RequestContext, id: string, input: { comment?: string }): Promise<ContentItemDto> {
    const authorized = await assertPermission(context, permissions.contentApprove);
    const item = await this.getContentById(context, id);
    ensureApprovalActionAllowed(item);
    const approval = await prisma.approvalRequest.findFirst({
      where: { contentItemId: id, workspaceId: context.workspaceId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) {
      throw new ConflictError('No pending approval request exists for this content');
    }
    if (approval.assignedToId && approval.assignedToId !== context.userId && !['owner', 'admin'].includes(authorized.membershipRole)) {
      throw new PolicyViolationError('This approval request is assigned to another reviewer');
    }
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'approved', decision: 'approved', comment: input.comment, decidedAt: new Date() },
    });
    const record = await prisma.contentItem.update({
      where: { id },
      data: { status: 'approved', reviewStatus: 'approved', updatedById: context.userId },
      include: { contentDestinations: true, mediaAssets: true },
    });

    await this.auditLogService.recordApprovalDecision(authorized, {
      action: 'approval.approved',
      approvalRequestId: approval.id,
      contentItemId: id,
      comment: input.comment ?? null,
    });

    return toContentDto(record as any);
  }

  async rejectContent(context: RequestContext, id: string, input: { comment: string }): Promise<ContentItemDto> {
    const authorized = await assertPermission(context, permissions.contentApprove);
    const item = await this.getContentById(context, id);
    ensureApprovalActionAllowed(item);
    const approval = await prisma.approvalRequest.findFirst({
      where: { contentItemId: id, workspaceId: context.workspaceId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) {
      throw new ConflictError('No pending approval request exists for this content');
    }
    if (approval.assignedToId && approval.assignedToId !== context.userId && !['owner', 'admin'].includes(authorized.membershipRole)) {
      throw new PolicyViolationError('This approval request is assigned to another reviewer');
    }
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'rejected', decision: 'rejected', comment: input.comment, decidedAt: new Date() },
    });
    const record = await prisma.contentItem.update({
      where: { id },
      data: { status: 'draft', reviewStatus: 'rejected', publishStatus: 'not_scheduled', updatedById: context.userId },
      include: { contentDestinations: true, mediaAssets: true },
    });

    await this.auditLogService.recordApprovalDecision(authorized, {
      action: 'approval.rejected',
      approvalRequestId: approval.id,
      contentItemId: id,
      comment: input.comment,
    });

    return toContentDto(record as any);
  }

  async scheduleContent(context: RequestContext, id: string, input: { scheduledAt: Date; destinationIds?: string[] }): Promise<ContentItemDto> {
    const authorized = await assertPermission(context, permissions.contentSchedule);
    const item = await this.getContentById(context, id);
    const settings = await this.settingsService.getSettings(context);
    ensureContentNotArchivedOrPublished(item);
    ensureScheduleAllowed(authorized, settings);
    requireApprovalForContent(settings, 'schedule', item.reviewStatus);
    const targetDestinationIds = input.destinationIds ?? item.destinations.map((destination) => destination.destinationId);
    if (!targetDestinationIds.length) {
      throw new InvalidStateTransitionError('Scheduling requires at least one destination');
    }

    const pausedDestinations = await prisma.destination.findMany({
      where: { workspaceId: context.workspaceId, id: { in: targetDestinationIds }, isPaused: true },
      select: { id: true },
    });
    if (pausedDestinations.length) {
      throw new PolicyViolationError('Cannot schedule content to paused destinations', { destinationIds: pausedDestinations.map((item: typeof pausedDestinations[number]) => item.id) });
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

    await this.auditLogService.recordContentAction(authorized, {
      action: 'content.scheduled',
      contentItemId: id,
      metadataJson: {
        scheduledAt: input.scheduledAt.toISOString(),
        destinationIds: targetDestinationIds,
      },
    });

    return toContentDto(record as any);
  }

  async publishNow(context: RequestContext, id: string): Promise<{ accepted: true; workflowRunId: string; publishJobIds: string[] }> {
    const authorized = await assertPermission(context, permissions.contentPublish);
    const item = await this.getContentById(context, id);
    const settings = await this.settingsService.getSettings(context);
    ensurePublishAllowed(authorized, settings, item);

    const pausedDestinations = await prisma.destination.findMany({
      where: { workspaceId: context.workspaceId, id: { in: item.destinations.map((destination) => destination.destinationId) }, isPaused: true },
      select: { id: true },
    });
    if (pausedDestinations.length) {
      throw new PolicyViolationError('Cannot publish content to paused destinations', { destinationIds: pausedDestinations.map((destination: typeof pausedDestinations[number]) => destination.id) });
    }

    const result = await this.publishingService.publishNow({
      workspaceId: context.workspaceId,
      contentItemId: id,
      requestedById: context.userId,
      idempotencyKey: context.idempotencyKey,
    });

    await this.auditLogService.recordContentAction(authorized, {
      action: 'content.publish_now',
      contentItemId: id,
      metadataJson: {
        workflowRunId: result.workflowRunId,
        publishJobIds: result.publishJobIds,
      },
    });

    return result;
  }
}
