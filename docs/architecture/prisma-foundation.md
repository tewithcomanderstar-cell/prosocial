# Prisma Foundation

This Prisma foundation establishes a PostgreSQL-first, platform-agnostic schema for the automation system.

## Goals

- Keep the core domain generic across platforms.
- Model publishing, approvals, runs, retries, and observability as first-class entities.
- Store provider-specific details in JSON fields instead of platform-specific tables.
- Support Facebook first without forcing the rest of the schema to become Facebook-shaped.

## Core principles

1. `Platform`, `Account`, `Credential`, and `Destination` form the connection layer.
2. `ContentItem` is the canonical content record.
3. `ContentDestination` is the per-destination publish bridge.
4. `Workflow`, `WorkflowStep`, `WorkflowRun`, and `WorkflowRunStep` form the automation layer.
5. `ApprovalRequest`, `Notification`, and `AuditLog` provide governance and operations visibility.
6. `PublishJob` isolates delivery retries from content authoring state.
7. `WebhookEvent` provides deduplication and run correlation for inbound provider events.

## Why there is no soft delete

Soft delete is intentionally omitted from the initial schema because:

- lifecycle statuses already represent operational state changes clearly;
- approvals, runs, and audits provide historical accountability;
- soft-delete filters often create unnecessary complexity in queue and run processing logic.

If retention requirements change later, archived states and table partitioning should be considered before introducing generic soft-delete flags.
