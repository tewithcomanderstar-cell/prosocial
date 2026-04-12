# Async Execution Layer V1

This document defines the Phase 3 async architecture for the platform-agnostic automation backend. The first provider is Facebook, but queue contracts, workers, schedulers, and webhook processing remain provider-neutral.

## Queue Architecture

### `workflowTriggerQueue`
Purpose:
- Accept lightweight trigger requests.
- Deduplicate scheduled, manual, and webhook-driven workflow starts.
- Hand off durable execution to `workflowRunnerQueue`.

Job types:
- `enqueueScheduledWorkflowTrigger`
- `enqueueWebhookTriggeredWorkflow`
- `enqueueManualWorkflowRun`

Idempotency:
- Redis lock using `workflow:${workspaceId}:${workflowId}:${triggerFingerprint}`.
- BullMQ `jobId` set from trigger identity.

Retry policy:
- 5 attempts.
- Retry transient infrastructure failures.
- Duplicate lock acquisition is treated as a successful skip.

### `workflowRunnerQueue`
Purpose:
- Advance a `WorkflowRun` through its ordered steps.
- Persist `WorkflowRunStep` records.
- Emit downstream side effects by creating jobs, not by embedding provider logic.

Job types:
- `runWorkflow`

Idempotency:
- `workflowRunId` is the durable execution identity.
- Steps are uniquely constrained by `(workflowRunId, stepOrder)`.

Retry policy:
- 3 attempts.
- Failing runs are marked failed and surfaced in the runs UI.

### `publishQueue`
Purpose:
- Publish one `ContentDestination` at a time.
- Keep each destination isolated for retries and failure handling.

Job types:
- `publishContentDestination`
- `retryPublishContentDestination`

Idempotency:
- Redis lock using `publish:${workspaceId}:${contentDestinationId}:${publishIntentKey}`.
- Provider-safe idempotency is additionally enforced by checking existing `externalPostId` and succeeded `PublishJob` state.
- BullMQ `jobId` uses `contentDestinationId + publishIntentKey`.

Retry policy:
- 8 attempts at queue level.
- Domain retry schedule uses exponential backoff with jitter and `nextAttemptAt` on `PublishJob`.

### `notificationQueue`
Purpose:
- Send in-app/email/LINE/Slack notifications asynchronously.

Job types:
- `sendNotification`
- `sendApprovalReminder`
- `sendFailureAlert`

Idempotency:
- Redis lock per `workspace + notification type + notificationId`.
- Queue `jobId` should be stable per notification.

Retry policy:
- 5 attempts.
- Permanent template or validation issues fail immediately.

### `webhookProcessingQueue`
Purpose:
- Normalize stored webhook events.
- Trigger downstream workflows or sync actions.

Job types:
- `processFacebookWebhookEvent`
- `processGoogleDriveWebhookEvent`
- `processGoogleSheetsWebhookEvent`

Idempotency:
- `WebhookEvent` DB unique key on `(provider, dedupKey)`.
- Queue job id bound to stored webhook event id.

Retry policy:
- 8 attempts.
- Invalid signature never enters processor queue.

### `credentialValidationQueue`
Purpose:
- Validate credentials asynchronously.
- Refresh destination metadata without blocking API requests.

Job types:
- `validateCredential`
- `refreshDestinationMetadata`

### `maintenanceQueue`
Purpose:
- Requeue retryable publish jobs.
- Detect stuck workflow runs.
- Archive old logs.

Job types:
- `detectStuckRuns`
- `archiveOldLogs`
- `requeueRetryablePublishJobs`

## Publish Orchestration

Flow:
1. API or scheduler calls `PublishingOrchestratorService.publishNow` or creates due publish intent.
2. Service creates `WorkflowRun` and `PublishJob` rows.
3. Service enqueues one publish job per `ContentDestination`.
4. Publish worker acquires Redis lock.
5. Worker loads content, destination, account, platform, and latest credential.
6. Worker validates destination and normalized payload through `PlatformPublisher`.
7. Worker calls provider adapter.
8. Worker persists `externalPostId`, provider response snapshot, and publish timestamps.
9. Worker updates `ContentDestination`, `ContentItem`, `PublishJob`, and optionally `WorkflowRun`.
10. Worker logs structured events and leaves notification emission to notification jobs.

## Error Classification

- `validation_error`: permanent, no retry.
- `auth_error`: permanent until credential reconnect.
- `permission_error`: permanent until permission fix.
- `provider_error_transient`: retryable.
- `provider_error_permanent`: permanent.
- `rate_limit_error`: retryable with backoff.
- `conflict_error`: permanent; often indicates duplicate publish intent.
- `invariant_violation`: permanent until data repaired.
- `internal_error`: retryable unless repeated enough to dead-letter.

## Cron / Scheduler Rules

Schedulers only discover and enqueue. They never call providers directly.

Recommended cadence:
- `enqueueScheduledContent`: every minute.
- `enqueueDueWorkflowTriggers`: every minute.
- `enqueueRetryablePublishJobs`: every minute.
- `validateExpiringCredentials`: every 15 minutes.
- `detectStuckRuns`: every 5 minutes.
- `sendNotificationDigests`: every 5 minutes.

All schedulers:
- use Redis lock per scheduler scope.
- run in bounded batches.
- emit structured logs with `correlationId` and counts.

## Webhook Ingestion

Route flow:
1. Receive request.
2. Preserve raw body and headers.
3. Verify signature when supported.
4. Persist `WebhookEvent` with `received` or `invalid_signature` status.
5. Deduplicate via DB unique key.
6. Enqueue processor job if accepted and not duplicate.
7. Return fast `202`.

Processor flow:
1. Mark processing.
2. Normalize provider payload to `NormalizedWebhookEvent`.
3. Enqueue downstream workflow trigger jobs.
4. Mark processed or failed.
5. Keep replay possible by retaining `WebhookEvent` rows.

## Normalized Webhook Contract

```ts
export type NormalizedWebhookEvent = {
  provider: string;
  eventType: string;
  eventId?: string;
  occurredAt?: string;
  workspaceRef?: string;
  accountRef?: string;
  destinationRef?: string;
  dedupKey: string;
  rawPayload: unknown;
  normalizedPayload: unknown;
};
```

Facebook mapping:
- `provider = facebook`
- `eventType = change.field`
- `eventId = entry.id`
- `destinationRef = entry.id`
- `dedupKey = sha256(object + entry.id + field + value)`
- `normalizedPayload` includes the original `change` object and the source page id.

## Observability

Every worker log line includes:
- `queue`
- `jobId`
- `correlationId`
- entity identifiers like `workflowRunId`, `publishJobId`, `webhookEventId`, `contentDestinationId`

Failures should be persisted to DB fields and emitted to logs. UI layers can read from `WorkflowRun`, `PublishJob`, and `WebhookEvent` without talking to Redis.

## Deferred To Later Phases

- Real provider API clients and payload sending.
- Queue dashboard UI.
- Manual replay UI.
- Durable idempotency persistence table.
- Distributed tracing and audit hook integration.
- Full RBAC policy enforcement.
