# Security and correctness boundaries

These invariants are acceptance criteria for the executable application and its high-level tests.

## Identity and tenancy

- An immutable repository/account ID accompanies every scoped row, credential, object, event, and execution attempt.
- Current grants, explicit denials, the credential ceiling, and mandatory organization policy all participate in authorization. A role name is not sufficient evidence.
- Permission revocation, visibility changes, credential expiry, and lifecycle changes are checked against authoritative metadata. Cached content is served only after that check.
- Browser sessions are HttpOnly, Secure in deployed environments, and protected against cross-site mutations. Federation callbacks use their protocol-specific nonce/state and response replay checks.
- An externally supplied identity header is never trusted as an authenticated actor. Authenticated service requests bind an exact operation scope, destination, request body, timestamp, and nonce.
- SSO account linking requires proof of an existing account or an approved provisioning identity, not merely a matching unverified email claim.

## Transactions and event delivery

- Revision-checked metadata mutations, audit records, and outbox events commit in a single D1 batch. Constraint failure rolls the complete batch back.
- An idempotency key is scoped to a principal and exact request. An uncertain request is reconciled before it can execute again. Current access is checked again before replaying a private result.
- Queue order and exactly-once delivery are not correctness assumptions. Source events survive queue loss and consumers deduplicate alongside their effects.
- External side effects have durable operation identities, bounded automatic retries, explicit failure records, and replay/reconciliation paths.

## Git publication

- Only GitKnot's trusted publication service receives canonical storage write authority. Users and job workspaces receive GitKnot capabilities.
- Every ref and relevant object is checked before publication. A stale-old lease is a freshness check; ancestry and policy are separate checks.
- Native Git never runs repository-supplied hooks, attributes filters, or build scripts in the trusted pool.
- Publication success requires accepted canonical refs and durable finalization. HTTP status alone is insufficient.
- An uncertain upstream request retains its repository fence. Expiring a local lease cannot cancel a write already sent to storage.
- Multi-ref updates require demonstrated atomic storage support; they never silently downgrade to partial publication.

## Execution and money

- Admission reserves the complete allowed attempt cost, including allocation, checkout, work, logs, and teardown, against every applicable budget before allocation.
- Duplicate dispatch attaches to the same attempt. Authenticated completion also checks the attempt generation, immutable plan, producer identity, and current lease.
- Queued runs and approval waits own no executor. Cancellation revokes capabilities and remains visible until execution termination is confirmed or a customer runner is unreachable.
- Secrets are selected by a trusted immutable plan and released by a private broker. Tenant names cannot select arbitrary platform bindings.
- Untrusted work has no trusted secrets or shared trusted cache write access. Exact source is restored independently of dependency caches; verification always executes for the candidate.
- Secret masking happens before persistence and spans log chunk boundaries. Secret-containing workspaces are not snapshotted.
- Allocation identities are recorded independently of SDK return paths. Deadlines, teardown verification, orphan reaping, instance caps, byte limits, and egress controls bound resource use.
- The financial ledger uses exact arithmetic and durable idempotent events. Sampled telemetry is never a source of billing truth.

## Data and recovery

- Object checksums do not grant access. The requested object must be associated with the currently authorized resource.
- Upload quotas are reserved atomically before receiving bytes. Unknown storage acceptance retains its reservation until reconciled.
- Backups include Git refs/objects, collaboration state, and referenced object manifests. Ordinary exports exclude credentials and decrypted secrets.
- A restore verifies integrity in a fresh cell, rebuilds projections, and fences stale credentials before reopening writes.
- Cell movement verifies the copy and switches a routing epoch under a write fence; an old destination cannot continue accepting writes.

Local protocol/behavior tests establish application invariants. Staging acceptance additionally establishes provider capability, isolation, teardown, size, latency, and cost limits for the exact deployed SDK/image/configuration combination. No deployment or provider acceptance is implied by an offline build.
