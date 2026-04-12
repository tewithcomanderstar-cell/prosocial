import { queueNames } from '@/src/jobs/queues/queue-names';
import { createQueue } from '@/src/jobs/queues/queue-factory';
import type { EnqueueManualWorkflowRunJob, EnqueueScheduledWorkflowTriggerJob, EnqueueWebhookTriggeredWorkflowJob, RunWorkflowJob } from '@/src/jobs/contracts/workflow.contracts';
import type { PublishContentDestinationJob, RetryPublishContentDestinationJob } from '@/src/jobs/contracts/publish.contracts';
import type { SendApprovalReminderJob, SendFailureAlertJob, SendNotificationJob } from '@/src/jobs/contracts/notification.contracts';
import type { ProcessFacebookWebhookEventJob, ProcessGoogleDriveWebhookEventJob, ProcessGoogleSheetsWebhookEventJob } from '@/src/jobs/contracts/webhook.contracts';
import type { ArchiveOldLogsJob, DetectStuckRunsJob, RefreshDestinationMetadataJob, RequeueRetryablePublishJobsJob, ValidateCredentialJob } from '@/src/jobs/contracts/maintenance.contracts';

export const workflowTriggerQueue = createQueue<EnqueueScheduledWorkflowTriggerJob | EnqueueWebhookTriggeredWorkflowJob | EnqueueManualWorkflowRunJob>(queueNames.workflowTriggerQueue, {
  attempts: 5,
  removeOnComplete: 1000,
  removeOnFail: 1000,
});

export const workflowRunnerQueue = createQueue<RunWorkflowJob>(queueNames.workflowRunnerQueue, {
  attempts: 3,
  removeOnComplete: 1000,
  removeOnFail: 1000,
});

export const publishQueue = createQueue<PublishContentDestinationJob | RetryPublishContentDestinationJob>(queueNames.publishQueue, {
  attempts: 8,
  removeOnComplete: 1000,
  removeOnFail: 2000,
});

export const notificationQueue = createQueue<SendNotificationJob | SendApprovalReminderJob | SendFailureAlertJob>(queueNames.notificationQueue, {
  attempts: 5,
  removeOnComplete: 2000,
  removeOnFail: 2000,
});

export const webhookProcessingQueue = createQueue<ProcessFacebookWebhookEventJob | ProcessGoogleDriveWebhookEventJob | ProcessGoogleSheetsWebhookEventJob>(queueNames.webhookProcessingQueue, {
  attempts: 8,
  removeOnComplete: 2000,
  removeOnFail: 5000,
});

export const credentialValidationQueue = createQueue<ValidateCredentialJob | RefreshDestinationMetadataJob>(queueNames.credentialValidationQueue, {
  attempts: 5,
  removeOnComplete: 1000,
  removeOnFail: 2000,
});

export const maintenanceQueue = createQueue<DetectStuckRunsJob | ArchiveOldLogsJob | RequeueRetryablePublishJobsJob>(queueNames.maintenanceQueue, {
  attempts: 3,
  removeOnComplete: 1000,
  removeOnFail: 1000,
});
