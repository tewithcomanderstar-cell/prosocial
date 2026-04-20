import { Types } from "mongoose";
import { Account } from "@/models/Account";
import { AutoPostAiConfig } from "@/models/AutoPostAiConfig";
import { ContentItem } from "@/models/ContentItem";
import { Destination } from "@/models/Destination";
import { FacebookConnection } from "@/models/FacebookConnection";
import { Platform } from "@/models/Platform";
import { Workflow } from "@/models/Workflow";
import { WorkflowRun } from "@/models/WorkflowRun";

type StartAutoPostRecordInput = {
  userId: string;
  configId: string;
  folderId: string;
  folderName: string;
  pageIds: string[];
  intervalMinutes: number;
  captionStrategy: "manual" | "ai" | "hybrid";
  captions: string[];
  aiPrompt: string;
  language: "th" | "en";
  source: string;
  triggeredAt: string;
};

type UpdateAutoPostRecordInput = {
  configId: string;
  currentJobStatus?: "pending" | "processing" | "posted" | "failed";
  autoPostStatus?: "idle" | "running" | "posting" | "success" | "failed" | "retrying" | "paused" | "waiting";
  lastError?: string | null;
  message?: string;
  pageId?: string;
  imageUsed?: string;
  nextRunAt?: string;
  lastRunAt?: string;
};

type ConfigRefs = {
  _id: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  targetPageIds?: string[];
  lastWorkflowId?: Types.ObjectId | string | null;
  lastWorkflowRunId?: Types.ObjectId | string | null;
  lastContentItemId?: Types.ObjectId | string | null;
};

function asObjectId(value: string) {
  return new Types.ObjectId(value);
}

function mapRunStatus(input: UpdateAutoPostRecordInput): "pending" | "running" | "succeeded" | "failed" | "cancelled" {
  if (input.currentJobStatus === "failed" || input.autoPostStatus === "failed") return "failed";
  if (input.currentJobStatus === "posted" || input.autoPostStatus === "success") return "succeeded";
  if (input.currentJobStatus === "processing" || ["running", "posting", "retrying"].includes(input.autoPostStatus || "")) return "running";
  if (["paused", "idle"].includes(input.autoPostStatus || "")) return "cancelled";
  return "pending";
}

function mapContentStatus(input: UpdateAutoPostRecordInput): "draft" | "pending_review" | "approved" | "scheduled" | "publishing" | "published" | "failed" | "archived" {
  if (input.currentJobStatus === "failed" || input.autoPostStatus === "failed") return "failed";
  if (input.currentJobStatus === "posted" || input.autoPostStatus === "success") return "published";
  if (input.currentJobStatus === "processing" || ["running", "posting", "retrying"].includes(input.autoPostStatus || "")) return "publishing";
  return "scheduled";
}

export async function createAutoPostAiRecords(input: StartAutoPostRecordInput) {
  const platform = await Platform.findOneAndUpdate(
    { key: "facebook" },
    { $setOnInsert: { key: "facebook", name: "Facebook", status: "active" } },
    { upsert: true, new: true }
  );

  const connection = await FacebookConnection.findOne({ userId: input.userId }).lean<{
    _id: Types.ObjectId;
    pages?: Array<{ pageId: string; name: string }>;
    tokenStatus?: string;
  } | null>();

  const account = await Account.findOneAndUpdate(
    { platformId: platform._id, userId: asObjectId(input.userId), externalAccountId: connection ? String(connection._id) : input.userId },
    {
      platformId: platform._id,
      userId: asObjectId(input.userId),
      externalAccountId: connection ? String(connection._id) : input.userId,
      displayName: connection?.pages?.[0]?.name || "Facebook Automation Account",
      status: ["warning", "expired", "disconnected"].includes(String(connection?.tokenStatus || ""))
        ? String(connection?.tokenStatus)
        : "connected",
      metadataJson: { source: "auto-post" }
    },
    { upsert: true, new: true }
  );

  const pageNameMap = new Map((connection?.pages || []).map((page) => [page.pageId, page.name]));
  const destinationIds: string[] = [];

  for (const pageId of input.pageIds) {
    const destination = await Destination.findOneAndUpdate(
      { platformId: platform._id, accountId: account._id, externalDestinationId: pageId },
      {
        platformId: platform._id,
        accountId: account._id,
        externalDestinationId: pageId,
        type: "page",
        name: pageNameMap.get(pageId) || `Facebook Page ${pageId.slice(-6)}`,
        status: "connected",
        permissionsJson: { publish: true },
        healthJson: { source: "facebook-connection", tokenStatus: connection?.tokenStatus || "unknown" }
      },
      { upsert: true, new: true }
    );
    destinationIds.push(String(destination._id));
  }

  const workflow = await Workflow.findOneAndUpdate(
    {
      createdBy: asObjectId(input.userId),
      name: "Facebook Automation Engine",
      triggerType: "schedule"
    },
    {
      workspaceId: undefined,
      createdBy: asObjectId(input.userId),
      name: "Facebook Automation Engine",
      status: "active",
      triggerType: "schedule",
      configJson: {
        source: "auto-post",
        configId: input.configId,
        folderId: input.folderId,
        folderName: input.folderName,
        intervalMinutes: input.intervalMinutes,
        language: input.language,
        captionStrategy: input.captionStrategy
      }
    },
    { upsert: true, new: true }
  );

  const contentItem = await ContentItem.create({
    createdBy: asObjectId(input.userId),
    title: `Auto Post batch ${new Date(input.triggeredAt).toLocaleString("en-CA")}`,
    bodyText: input.aiPrompt || input.captions[0] || "Auto-generated Facebook automation batch",
    status: "scheduled",
    platformPayloadJson: {
      platformKey: "facebook",
      folderId: input.folderId,
      folderName: input.folderName,
      pageIds: input.pageIds,
      captionStrategy: input.captionStrategy,
      captions: input.captions,
      aiPrompt: input.aiPrompt,
      language: input.language,
      source: input.source
    },
    destinationIds,
    mediaAssetIds: [],
    approvalRequired: false,
    scheduledAt: new Date(input.triggeredAt)
  });

  const workflowRun = await WorkflowRun.create({
    workflowId: workflow._id,
    contentItemId: contentItem._id,
    triggerSource: input.source === "manual-start" ? "manual" : "schedule",
    status: "running",
    startedAt: new Date(input.triggeredAt),
    inputJson: {
      configId: input.configId,
      folderId: input.folderId,
      folderName: input.folderName,
      pageIds: input.pageIds,
      intervalMinutes: input.intervalMinutes,
      captionStrategy: input.captionStrategy,
      captionsCount: input.captions.length,
      language: input.language,
      source: input.source
    },
    outputJson: {
      stage: "triggered"
    }
  });

  await AutoPostAiConfig.findByIdAndUpdate(input.configId, {
    lastWorkflowId: workflow._id,
    lastWorkflowRunId: workflowRun._id,
    lastContentItemId: contentItem._id
  });

  return {
    workflowId: String(workflow._id),
    workflowRunId: String(workflowRun._id),
    contentItemId: String(contentItem._id)
  };
}

export async function updateAutoPostAiRecords(input: UpdateAutoPostRecordInput) {
  const config = await AutoPostAiConfig.findById(input.configId).lean<ConfigRefs | null>();
  if (!config) {
    return null;
  }

  const runStatus = mapRunStatus(input);
  const contentStatus = mapContentStatus(input);
  const updatePayload = {
    status: runStatus,
    errorMessage: input.lastError || undefined,
    ...(runStatus === "succeeded" || runStatus === "failed" || runStatus === "cancelled" ? { finishedAt: new Date() } : {}),
    outputJson: {
      stage: input.autoPostStatus || input.currentJobStatus || "updated",
      message: input.message,
      pageId: input.pageId,
      imageUsed: input.imageUsed,
      nextRunAt: input.nextRunAt,
      lastRunAt: input.lastRunAt,
      autoPostStatus: input.autoPostStatus,
      currentJobStatus: input.currentJobStatus
    }
  };

  if (config.lastWorkflowRunId) {
    await WorkflowRun.findByIdAndUpdate(config.lastWorkflowRunId, updatePayload);
  }

  if (config.lastContentItemId) {
    await ContentItem.findByIdAndUpdate(config.lastContentItemId, {
      status: contentStatus,
      ...(contentStatus === "published" ? { publishedAt: new Date() } : {}),
      ...(input.nextRunAt ? { scheduledAt: new Date(input.nextRunAt) } : {})
    });
  }

  return {
    workflowRunId: config.lastWorkflowRunId ? String(config.lastWorkflowRunId) : undefined,
    contentItemId: config.lastContentItemId ? String(config.lastContentItemId) : undefined,
    workflowId: config.lastWorkflowId ? String(config.lastWorkflowId) : undefined
  };
}
