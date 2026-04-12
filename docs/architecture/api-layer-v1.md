# API Layer v1 Foundation

This phase introduces versioned `/api/v1` routes backed by modular services under `src/modules`.

## Principles

- Route handlers stay thin.
- Workspace scoping is enforced through request context.
- Validation uses Zod at the API boundary.
- Business rules live in services.
- Publishing orchestration is generic and does not call providers inline.
- Queue workers, cron processors, and webhook handlers are intentionally deferred.

## Module layout

- `src/lib`: shared request context, errors, validation, and response helpers
- `src/modules/*`: schemas, types, and services for each domain area
- `app/api/v1/*`: thin versioned route handlers

## Important deferred concerns

- durable idempotency persistence
- queue/job locking
- cron scheduling
- provider execution adapters
- webhook signature verification and processing
- RBAC policy engine wiring
