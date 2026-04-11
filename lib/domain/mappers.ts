import type { ApprovalRequest, ContentItem, WorkflowRun } from "@/lib/domain/types";

type LegacyPostShape = {
  _id?: string | { toString(): string };
  userId?: string | { toString(): string };
  title?: string | null;
  content?: string | null;
  status?: string | null;
  targetPageIds?: string[] | null;
  imageUrls?: string[] | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  lastPublishedAt?: Date | string | null;
};

type LegacyApprovalShape = {
  _id?: string | { toString(): string };
  postId?: string | { toString(): string };
  requestedByUserId?: string | { toString(): string } | null;
  assignedToUserId?: string | { toString(): string } | null;
  status?: string | null;
  note?: string | null;
  updatedAt?: Date | string | null;
};

type LegacyJobShape = {
  _id?: string | { toString(): string };
  scheduleId?: string | { toString(): string } | null;
  postId?: string | { toString(): string } | null;
  type?: string | null;
  status?: string | null;
  nextRunAt?: Date | string | null;
  processingStartedAt?: Date | string | null;
  completedAt?: Date | string | null;
  lastError?: string | null;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
};

function asId(value: string | { toString(): string } | null | undefined) {
  return value ? String(value) : "";
}

function asIso(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mapJobStatus(status?: string | null): WorkflowRun["status"] {
  switch (status) {
    case "queued":
      return "pending";
    case "processing":
    case "retrying":
      return "running";
    case "success":
      return "succeeded";
    case "failed":
    case "rate_limited":
    case "duplicate_blocked":
      return "failed";
    default:
      return "pending";
  }
}

export function deriveContentItemStatus(
  post: LegacyPostShape,
  approval?: LegacyApprovalShape | null,
  latestJob?: LegacyJobShape | null
): ContentItem["status"] {
  if (latestJob?.status === "processing" || latestJob?.status === "retrying") return "publishing";
  if (approval?.status === "pending") return "pending_review";
  if (approval?.status === "approved" && (post.status === "draft" || !post.status)) return "approved";

  switch (post.status) {
    case "scheduled":
      return "scheduled";
    case "published":
      return "published";
    case "failed":
      return "failed";
    default:
      return "draft";
  }
}

export function mapLegacyPostToContentItem(
  post: LegacyPostShape,
  approval?: LegacyApprovalShape | null,
  latestJob?: LegacyJobShape | null
): ContentItem {
  return {
    id: asId(post._id),
    workspaceId: "legacy-workspace",
    title: post.title?.trim() || "Untitled content",
    bodyText: post.content?.trim() || "",
    status: deriveContentItemStatus(post, approval, latestJob),
    platformPayloadJson: {
      targetPageIds: post.targetPageIds || [],
      imageUrls: post.imageUrls || []
    },
    createdBy: asId(post.userId),
    scheduledAt: asIso(latestJob?.nextRunAt),
    publishedAt: asIso(post.lastPublishedAt),
    destinationIds: post.targetPageIds || [],
    mediaAssetIds: post.imageUrls || [],
    approvalRequired: Boolean(approval)
  };
}

export function mapLegacyApprovalToApprovalRequest(approval: LegacyApprovalShape): ApprovalRequest {
  const status = approval.status === "rejected"
    ? "rejected"
    : approval.status === "approved"
      ? "approved"
      : "pending";

  return {
    id: asId(approval._id),
    contentItemId: asId(approval.postId),
    requestedBy: asId(approval.requestedByUserId),
    assignedTo: asId(approval.assignedToUserId) || undefined,
    status,
    comment: approval.note || undefined,
    decidedAt: status === "pending" ? undefined : asIso(approval.updatedAt)
  };
}

export function mapLegacyJobToWorkflowRun(job: LegacyJobShape): WorkflowRun {
  return {
    id: asId(job._id),
    workflowId: asId(job.scheduleId) || "legacy-automation",
    contentItemId: asId(job.postId) || undefined,
    triggerSource: job.type || "manual",
    status: mapJobStatus(job.status),
    startedAt: asIso(job.processingStartedAt),
    finishedAt: asIso(job.completedAt),
    errorMessage: job.lastError || undefined,
    inputJson: job.payload || {},
    outputJson: job.result || {}
  };
}
