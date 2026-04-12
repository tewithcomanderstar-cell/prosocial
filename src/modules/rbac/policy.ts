import { ApprovalRequiredError, InvalidStateTransitionError, PolicyViolationError } from '@/src/lib/errors';
import type { AuthorizedContext } from '@/src/modules/rbac/rbac.service';
import type { WorkspaceSettingsDto } from '@/src/modules/settings/settings.types';

type ContentSnapshot = {
  id: string;
  title: string | null;
  bodyText: string | null;
  status: string;
  reviewStatus: string;
  publishStatus: string;
  destinations: Array<{ destinationId: string; publishStatus: string }>;
};

export function requireApprovalForContent(settings: WorkspaceSettingsDto, action: 'publish' | 'schedule', reviewStatus: string) {
  if (action === 'publish' && settings.approvalRequiredBeforePublish && reviewStatus !== 'approved') {
    throw new ApprovalRequiredError('Approval is required before publishing');
  }

  if (action === 'schedule' && settings.approvalRequiredBeforeSchedule && reviewStatus !== 'approved') {
    throw new ApprovalRequiredError('Approval is required before scheduling');
  }
}

export function ensureContentNotArchivedOrPublished(content: ContentSnapshot) {
  if (content.status === 'archived') {
    throw new InvalidStateTransitionError('Archived content cannot be modified');
  }

  if (content.status === 'published') {
    throw new InvalidStateTransitionError('Published content cannot be modified through this action');
  }
}

export function ensureContentReadyForReview(content: ContentSnapshot) {
  if (!content.title && !content.bodyText) {
    throw new InvalidStateTransitionError('Content must have title or body text before review');
  }

  if (content.status === 'published' || content.status === 'archived') {
    throw new InvalidStateTransitionError('Published or archived content cannot be submitted for review');
  }

  if (content.reviewStatus === 'pending') {
    throw new InvalidStateTransitionError('Content is already pending review');
  }
}

export function ensureApprovalActionAllowed(content: ContentSnapshot) {
  if (content.status === 'archived') {
    throw new InvalidStateTransitionError('Archived content cannot be approved or rejected');
  }

  if (content.status === 'published') {
    throw new InvalidStateTransitionError('Published content cannot be approved or rejected');
  }

  if (content.reviewStatus !== 'pending') {
    throw new InvalidStateTransitionError('Only content pending review can be approved or rejected');
  }
}

export function ensureScheduleAllowed(context: AuthorizedContext, settings: WorkspaceSettingsDto) {
  if (context.membershipRole === 'editor' && !settings.allowEditorsToSchedule) {
    throw new PolicyViolationError('Editors are not allowed to schedule content in this workspace');
  }
}

export function ensurePublishAllowed(context: AuthorizedContext, settings: WorkspaceSettingsDto, content: ContentSnapshot) {
  requireApprovalForContent(settings, 'publish', content.reviewStatus);

  if (!content.destinations.length) {
    throw new InvalidStateTransitionError('Cannot publish content without at least one destination');
  }

  if (content.publishStatus === 'publishing') {
    throw new InvalidStateTransitionError('Content is already publishing');
  }

  if (context.membershipRole === 'operator' && !settings.allowOperatorsToPublish) {
    throw new PolicyViolationError('Operators are not allowed to publish in this workspace');
  }
}
