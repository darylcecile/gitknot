# Implementation contract

GitKnot is implemented as a Node 24 / TypeScript npm-workspace monorepo. Cloudflare deployment configuration uses `cf/config` and `cloudflare.config.ts`, not handwritten Wrangler deployment configuration. The product domains are `gitknot.com`, `api.gitknot.com`, and `git.gitknot.com`; staging uses `staging.gitknot.com`, `api.staging.gitknot.com`, and `git.staging.gitknot.com`.

The new `cf` CLI requires the **2.0 beta** Cloudflare Vite plugin, not the npm `latest` 1.x line. Root pins `cf@1.0.0-beta.12` and `@cloudflare/vite-plugin@2.0.0-beta.sha-52b0dc0e9`; each Worker workspace that calls `cf build` must declare its build tool in its own manifest. Official reference: https://developers.cloudflare.com/cf/projects/#how-cf-runs-your-project. Builds are offline and non-deploying. Local resource CLI state and Vite local state have different defaults, so setup must explicitly align their persistence paths.

## Module boundaries

- `packages/core`: platform types, HTTP/API conventions, SQL helpers, current-state authorization, routing, transactional events.
- `apps/api/src/modules`: Hono route registration functions; module files export `register<Name>Routes(app: App): void`.
- `apps/api/src/index.ts`: composition root, middleware, health and static assets.
- `apps/web`: React/Vite web application, calls the `/v1` API with cookie credentials.
- `packages/workflows`: portable declarative compiler and frozen run manifests.
- `packages/cli` and `packages/runner`: public CLI and outbound-only customer runner.
- `packages/git`, `workers/git`, `services/git`: Artifacts adapter, HTTPS gateway/coordinator, trusted native Git service.
- `packages/execution`, `workers/execution`, `workers/background`: hosted adapter, orchestration, dispatch, event processing.
- `packages/billing`, `packages/secrets`, `workers/secrets`: admission and ledger, encrypted tenant vault/private broker.
- `infra`, `scripts`: typed resource plans, local setup, repeatable provisioning/build instructions.
- `migrations`: numbered SQL files. Core `000_*`, identity/catalog `001_*`–`019_*`, collaboration `020_*`–`039_*`, workflows `040_*`–`059_*`, billing/secrets `060_*`–`079_*`, operations/events `080_*`–`099_*`.
- `tests/high-level`, `tests/e2e`: behavior and real protocol/user journeys. Avoid small implementation-mirroring unit tests.

Use real durable adapters in production. Local adapters must be explicitly selected and must not silently replace a missing production binding. No unconditional success, fake remote results, or placeholder feature endpoints.

## Shared API contracts

Import `App`, `AppContext`, `Bindings`, `Principal`, `Repository`, and shared helpers from `@gitknot/core`. Imports within packages use `.ts` extensions. JSON and database fields use `snake_case`. Timestamps are UTC RFC3339 strings. Stable resource IDs have semantic prefixes (`u_`, `org_`, `r_`, `run_`, etc.) and opaque random suffixes.

`Principal` has `id`, `kind`, `user_id`, `credential_id`, `capabilities: string[] | null`, `repository_ids: string[] | null`, `account_ids: string[] | null`, and `mfa`. `null` means the credential itself adds no restriction; role/policy authorization is still required. Context variables: `principal: Principal | null`, `requestId: string`, `database: D1DatabaseSession`, `input: unknown`.

`database(c)` returns a per-request D1 `first-primary` session. Helpers: `one<T>(db, sql, ...bindings)`, `many<T>(db, sql, ...bindings)`, `execute(db, sql, ...bindings)`, `stmt(db, sql, ...bindings)`, `newId(prefix)`, `now()`, `sha256(string | Uint8Array)`, `jsonBody(c, zodSchema)`, `page(c)` returning `{limit,cursor}`, `listResponse(c, items, nextCursor?)`, `etag(revision)`, `expectedRevision(c)` requiring `If-Match`, `requirePrincipal(c)`.

`route(app, method, path, {summary, tags?, body?, capability?, responses?}, handler)` registers a Hono route and OpenAPI metadata. Use it for all public endpoints. `body` is a Zod schema, validated automatically and returned by `jsonBody` without rereading the body. Response envelopes: single resources are plain JSON; lists are `{items, next_cursor}`; errors are `{error:{code,message,request_id,details?}}`. Mutations use strong ETags and `If-Match`. Create operations accept `Idempotency-Key`. Permission failures to a private resource normally return `404` to avoid revealing its existence.

`authorize(c, capability, {repo_id?, account_id?, ref?, paths?})` returns a permission explanation or throws a structured error. `getRepository(c, id, capability = 'contents.read')` returns the current repository after authorization/lifecycle checks. Authorization implementation is owned by identity; other modules consume it. `eventStatement(db, event)` and `auditStatement(db, audit)` support atomic batches. `mutate(c, {sql, bindings, event, audit?, after?})` executes a single-row revision-checked write plus follow-up statements and outbox/audit in one batch; failure of the first write rolls the whole batch back. For multi-row operations use explicit guarded D1 batches. Raw provider errors never form a public response.

## Authoritative common tables

Identity owns these schemas and must keep these columns available:

- `users`: `id, username, email, display_name, bio, avatar_url, password_hash, email_verified_at, disabled_at, revision, created_at, updated_at`.
- `accounts`: `id, type ('user'|'organization'), slug, name, owner_user_id, revision, created_at, updated_at`.
- `repositories`: `id, owner_id, name, slug, description, visibility ('public'|'private'|'internal'|'unlisted'), default_branch, state ('provisioning'|'active'|'archived'|'transfer_pending'|'moving'|'deleted'), revision, policy_revision, routing_epoch, cell_id, shard_id, storage_name, fork_source_id, created_by, created_at, updated_at, deleted_at, recovery_until`.
- `memberships`: include `account_id, principal_id, role_id, state`.
- `credentials`: bearer/session hashes, scoped grants, expiration and revocation. Never plaintext long-lived secrets.

Core owns `outbox`, `audit_log`, `processed_events`, `idempotency_keys`, `mutation_guards`, `resource_routes`, `operations`, `object_manifests`. Modules add normalized tables with repository/account ownership in every row and suitable indexed cursors. Scope every SQL read and write explicitly; knowing an opaque ID does not grant access.

## Bindings

`DB` is the initial cell-local authoritative D1 database; the routing layer supports bounded additional shards. `DIRECTORY_DB`, `SEARCH_DB` are separate D1 databases. `BLOBS`, `BACKUPS` are separate private R2 buckets. Queues: `EVENTS`, `DISPATCH`, `WEBHOOK_DELIVERIES`, `MAIL_DELIVERIES` with DLQs. Services: `GIT_SERVICE`, `SECRETS`, `EXECUTOR`, `API`. Durable Objects: `REPO_COORDINATOR` (class `RepositoryCoordinator`), `ADMISSION` (class `AdmissionController`), `ATTEMPTS` (class `AttemptController`). Workflows: `RUN_WORKFLOW` (class `RunWorkflow`), `OPERATIONS` (class `OperationWorkflow`). `ARTIFACTS` is the provider Git namespace binding. `SANDBOX` is the pinned hosted Sandbox class. Add more typed bindings where needed and document them.

Public config: `ENVIRONMENT`, `APP_ORIGIN`, `API_ORIGIN`, `GIT_ORIGIN`, `CELL_ID`, `SHARD_ID`, `LIMITS_JSON`. Internal authentication uses scoped service bindings and/or `INTERNAL_SERVICE_KEY` signed requests; never trust a public `X-Actor` header. Only the secrets broker receives key-encryption keys. Bindings that depend on provisioned resources are named in config, and resource IDs are read from operator state; builds and local setup must not require live credentials or create cloud resources.

## Integration details

All Git mutations, including merge and browser edits, enter the same canonical publication gate. The gateway sends trusted native operations to `GIT_SERVICE` over authenticated internal HTTP; the service never executes repository code. All workflow and runner records reference immutable repository/commit/plan/attempt identities. Outputs are accepted only from current, scoped attempts. Budget reservations precede allocation, and cleanup remains possible when budgets are exhausted. Event consumers retain source events for replay and deduplicate in the same transaction as their effects.

Core schema is authoritative in `migrations/000_core.sql`. Outbox has the complete event in `event_json`, data-only `payload_json`, `status`, `attempts`, `next_attempt_at`, `published_at`, and `last_error`; `processed_events` is keyed `(consumer,event_id)`. Operations use `kind`, `status` (`pending|waiting|running|completed|failed|cancelled`), `phase`, `progress`, `revision`, `input_json`, `result_json`, `error_json`, and `workflow_id`. Object manifests use `object_key`, `bucket` (`blobs|backups`), `filename`, `bytes`, `sha256`, `state` (`pending|uploading|ready|deleting|deleted|failed`), `created_by`, `retention_until`, and `reference_count`. See the migration for complete fields. Core exports `ApiError(status,code,message,details?)`, `mutationGuard`, `makeEvent`, `internalFetch`, `signInternalRequest`, `verifyInternalRequest`, `boundedStream`, `readBounded`, `encodeCursor`, `decodeCursor`, `canonicalJson`, and crypto helpers. `mutate` expects exactly one row affected by its first statement and rolls the batch back otherwise. `event.resource_revision` is required. Browser unsafe cookie-auth requests must send `X-GitKnot-CSRF: 1` with the allowed origin. Internal JSON signatures cover method, host, path, body digest, exact service scope, timestamp, and nonce; external cross-account recipients should pass a database to nonce verification.

Standalone uploads start in `reserving`, then become `pending` only after account-wide storage admission. `billing_reservation_id`/`billing_fence` identify the hold. Repository quota counters remain shard-local; account quota and storage cost commitments belong to the account coordinator. `upload_generation` increments before a put. A persisted `upload_failure='input_incomplete'` means that generation definitively failed its streamed byte/checksum contract; a zero `upload_bytes_received` alone is **not** evidence that no write is in flight. Unknown acceptance retains `uploading` and its holds. Background cancellation must verify that a producer was never admitted or is definitively fenced before releasing that hold.

Implementation agents own their assigned directories/files and numbered schema range. Do not edit another agent's files, root manifests, or composition root without coordinating. Record integration contracts in a module README when not covered above. Research current provider/library APIs through official docs/Context7. Only native SSH is deferred. Do not deploy or mutate a Cloudflare account. Implement complete features before running checks; run focused high-level verification once, then report interfaces and unresolved integration concerns honestly.
