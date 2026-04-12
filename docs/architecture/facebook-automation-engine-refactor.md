# Facebook-first Automation Engine Refactor

## Current repo fit
This codebase already has the right raw ingredients for an automation engine:
- Next.js App Router pages and APIs under `D:\html\app`
- operational UI panels in `D:\html\components`
- Mongoose models in `D:\html\models`
- service layer in `D:\html\lib\services`
- n8n-backed Facebook publishing workflow

The current product, however, is still shaped around feature slices like `facebook`, `auto-post`, `planner`, and `posts` rather than a platform-neutral automation core.

## Main architectural issues in the current codebase
1. **Facebook-specific domain leakage**
   - `AutoPostConfig`, `FacebookConnection`, `Post`, and `PostApproval` encode Facebook assumptions directly into core business workflows.
   - `processDueAutoPosts()` in `D:\html\lib\services\auto-post.ts` imports Facebook-specific services directly.

2. **Content and automation are coupled too tightly**
   - `Post` is trying to act as draft content, scheduled item, publish target, and publish result simultaneously.
   - Workflow concepts live in `WorkflowAutomation`, but execution/run detail is delegated to `Job` and n8n state rather than a first-class run model.

3. **Integrations are provider-flavored instead of platform-neutral**
   - `IntegrationConnection` and `FacebookConnection` overlap.
   - Google Drive and Facebook are modeled as separate concerns rather than connectors feeding a generic automation engine.

4. **Observability is split across logs, jobs, approvals, and callback status**
   - There is no single, stable `WorkflowRun` / `Execution` abstraction for product analytics, retries, and replay.

## Target architecture inside this repo

### New domain layer
Add a stable domain package under `D:\html\lib\domain`:
- `types.ts`
- `schemas.ts`

These define reusable entities:
- `Platform`
- `Account`
- `Destination`
- `Credential`
- `ContentItem`
- `MediaAsset`
- `Workflow`
- `WorkflowStep`
- `WorkflowRun`
- `ApprovalRequest`
- `Notification`
- `AuditLog`

### New provider layer
Add `D:\html\lib\platforms`:
- `publisher.ts` generic publishing contract
- `facebook\facebook-publisher.ts` first provider implementation

This keeps Facebook logic out of the core engine.

### New automation layer
Add `D:\html\lib\automation`:
- `engine.ts`

This defines:
- workflow execution context
- step handler contract
- publish step handler using platform registry

## Recommended folder/module structure

```text
D:\html
  app
    (dashboard + admin pages)
    api
      automation
      content
      platforms
      approvals
      runs
      notifications
      system
  components
    automation
    content
    destinations
    approvals
    runs
    shared
  lib
    domain
      types.ts
      schemas.ts
    platforms
      publisher.ts
      facebook\facebook-publisher.ts
    automation
      engine.ts
      registry.ts
      handlers\
    services
      content.ts
      queue.ts
      approvals.ts
      notifications.ts
      analytics.ts
      facebook.ts
      google-drive.ts
  models
    Platform.ts
    Account.ts
    Destination.ts
    Credential.ts
    ContentItem.ts
    MediaAsset.ts
    Workflow.ts
    WorkflowStep.ts
    WorkflowRun.ts
    ApprovalRequest.ts
    Notification.ts
    AuditLog.ts
```

## Data-model migration mapping from current models

| Current model | Target model | Notes |
|---|---|---|
| `FacebookConnection` | `Account` + `Credential` + `Destination` | split connection from pages and tokens |
| `GoogleDriveConnection` | `Account` + `Credential` | connector account |
| `IntegrationConnection` | `Platform` + `Account` summary | keep as temporary compatibility table only |
| `Post` | `ContentItem` | content state machine moves here |
| `MediaAsset` | `MediaAsset` | keep but attach to content item formally |
| `PostApproval` | `ApprovalRequest` | generic approval flow |
| `WorkflowAutomation` | `Workflow` + `WorkflowStep` | step-by-step builder |
| `Job` | `WorkflowRun` | run history and observability |
| `ActionLog` / `AuditEntry` | `AuditLog` | consolidate where practical |
| `AutoPostConfig` | `Workflow` config + destination policy settings | keep temporarily for backward compatibility |

## API evolution proposal

### Keep existing routes during transition
Do not delete current routes yet. Wrap them behind new service modules.

### Add platform-neutral routes
- `GET /api/platforms`
- `GET /api/accounts`
- `GET /api/destinations`
- `GET /api/content-items`
- `POST /api/content-items`
- `POST /api/content-items/:id/submit-approval`
- `POST /api/content-items/:id/approve`
- `POST /api/content-items/:id/reject`
- `GET /api/workflows`
- `POST /api/workflows`
- `GET /api/workflows/:id/runs`
- `POST /api/workflows/:id/test-run`
- `POST /api/workflow-runs/:id/retry`
- `GET /api/notifications`
- `GET /api/audit-logs`

### Backward-compatible wrappers
Existing routes like `app/api/auto-post/*` can become facades over new automation services.

## UI restructuring proposal

### Navigation
- Overview
  - Dashboard
  - Runs
  - Alerts
- Automation
  - Workflows
  - Templates
- Content
  - Posts
  - Queue
  - Planner
  - Media Library
  - AI Tools
- Facebook
  - Pages
  - Connections
  - Permissions
- Team
  - Members
  - Roles
  - Approvals
- System
  - Logs
  - Settings
  - API / Webhooks

### Page mapping from current app
- `app/dashboard/page.tsx` -> keep, rebuild metrics around engine health
- `app/auto-post/page.tsx` -> convert into `Automation > Workflows` landing
- `app/planner/page.tsx` -> keep as `Content > Planner`
- `app/settings/page.tsx` -> split into system settings + workspace defaults
- `app/connections/facebook/page.tsx` -> becomes `Facebook > Connections`
- `app/logs/page.tsx` -> becomes `System > Logs`

## First concrete code changes already scaffolded
- `D:\html\lib\domain\types.ts`
- `D:\html\lib\domain\schemas.ts`
- `D:\html\lib\platforms\publisher.ts`
- `D:\html\lib\platforms\facebook\facebook-publisher.ts`
- `D:\html\lib\automation\engine.ts`

These files establish the platform-neutral contracts we can build the rest of the refactor around.

## Recommended phased rollout

### Phase 1: Stabilize and abstract
- Keep current UI alive.
- Introduce new domain types and provider contracts.
- Make Facebook publishing go through `PlatformPublisher`.
- Wrap n8n orchestration in generic workflow run records.

### Phase 2: Re-model core entities
- Add new models: `Destination`, `Credential`, `ContentItem`, `WorkflowRun`, `ApprovalRequest`.
- Start writing to both old and new models where needed.

### Phase 3: Rebuild product surfaces
- Queue page
- Runs page
- Workflow builder page
- Approvals page
- Facebook connections health page

### Phase 4: Retire old assumptions
- Deprecate direct Facebook-specific app routes from core workflow logic.
- Keep Facebook only in `platforms/facebook` and UI labels.

## Suggested first PRs
1. **PR 1 - Domain contracts and provider registry**
   - add `lib/domain/*`
   - add `lib/platforms/*`
   - add `lib/automation/engine.ts`

2. **PR 2 - New models and migration helpers**
   - add generic Mongoose models
   - keep old models for compatibility

3. **PR 3 - Workflow run observability**
   - add runs list + run detail API and UI

4. **PR 4 - Content queue refactor**
   - add queue status model and actions

5. **PR 5 - Approval flow hardening**
   - reviewer assignment, comments, version trail

6. **PR 6 - Facebook health and token management**
   - token warnings, permission checks, reconnect UX

7. **PR 7 - Workflow builder simplification**
   - ordered steps, test run, enable/disable
