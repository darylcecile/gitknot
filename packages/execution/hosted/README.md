# Shared hosted execution hardening

Both deployments invoke the real pinned `@cloudflare/ci@0.2.0` / `@cloudflare/sandbox@0.12.1` pipeline through `runSdkJob`. `src/hosted/job-scripts.ts` and `runtime-journal.ts` provide shared kernel supervision, one-shot startup, sealed IDs, and operation/stream tracking. The remote Worker reexports these shared implementations.

## Same-account execution

`runHostedAttempt` resolves `executionResourceEnvironment(env, attemptId, 'attempt')` before reading metadata. That helper preserves `IDENTITY_DB`, `IDENTITY_CELL_ID`, and `IDENTITY_SHARD_ID`; metadata placement is selected by the routing authority and named bindings, never by comparing DB objects.

Inside the actual SDK source-provider step, the local adapter consumes an immutable SQL claim before calling `begin-hosted`. A positive begin and current scoped checkout capability are required before the Sandbox's `activate(input, sourceUrl)` RPC enables VM startup. Admission may call `arm({attempt_id,generation})` earlier; arming alone cannot start a VM. SDK retries cannot boot a second instance or start the same command twice.

The Sandbox registers outbound handlers through the SDK setters and passes only the snapshot bucket/transport settings to SDK env. It blocks inherited unawaited startup probes. Returned file streams remain journaled through EOF or cancellation. A root-owned supervisor starts each user command as uid/gid 10000 with cleared groups/capabilities, no-new-privileges, fixed process groups, quotas, and absolute step/job/lease deadlines. Tenant environment variables reach `/usr/bin/env -i` only **after** the privilege drop. Source credentials are limited to trusted checkout and revoked before repository commands; they are never copied into the job configuration or Workflow checkpoint.

The image adds the IPv4/IPv6 firewall tools needed to block uid 10000 from the local SDK/control endpoints. Image startup fails closed if the required kernel controls are unavailable. The final built image must be digest-pinned and genuinely measured in the hosted profile.

## Durable checkpoints and recovery

Migration `055_local_hosted_checkpoints.sql` adds:

- `local_hosted_checkpoints`: an immutable per-attempt execution claim, normalized completion draft/hash, and finalized receipt/hash.
- `local_hosted_log_chunks`: already-redacted pending chunks with immutable sequence/checksum identity. Acknowledged chunk payloads are removed from this journal after durable object storage accepts them.

No source capability, tenant secret value, redaction carry, provider token, or raw SDK error/result is stored in this journal. An outer `hostedCheckpointGuard` enforces persistence before a real Workflow step returns, including when CI swallows `destroy()` errors. CP completion remains the authority; SDK success is never an accepted verification result.

Replay calls `reconcileLocalHostedAttempt` against the existing allocation. It never invokes command execution. The CP can import **`readLocalHostedDraft(env, attemptId, generation)` from `@gitknot/execution/hosted/checkpoints`** without pulling in the SDK: it returns the finalized `CompletionReceipt | null`. For a local running attempt with a draft, CP independently destroys/verifies the runtime and submits it through normal authoritative completion. `/internal/runtime/{arm,destroy}` request bodies remain `{attempt_id,generation}`.

Sandbox alarms and CP scheduled attempt reconciliation supply independent cleanup. The permanent seal is durable before termination. SDK destruction and `ctx.container.running === false`, settled operations/streams, and cleanup of uncommitted storage are required for proof. An immutable persisted scope permits physical shutdown during metadata/identity outages; D1 proof projection waits for current metadata authority. D1 preserves the first `destroyed_at` observation on replay, including rehydration, so billing sees a stable proof. Local receipts use the default `hosted_destroyed` proof kind.

## Trusted retained snapshots

The same-account `BACKUP_BUCKET` is retained storage. It must be configured consistently with billing's snapshot physical-storage binding. The SDK uses real `localBucket:true` binding transfers without provider credentials in the VM.

Every generated SDK key is journaled before reservation or bytes. Uploads enforce size/lease limits and compute the raw SHA-256 of the complete stream before billing commit. Only the two UUID-scoped SDK files are accessible; cache reads require the current repository/trust/toolchain cache namespace. Multipart/presigned SDK operations and arbitrary bucket enumeration are blocked.

Sanitized snapshots are committed to `execution_snapshots` / `execution_caches` through a fenced, idempotent publication step. A durable commit intent protects snapshots whose D1 publication reply was lost. Cleanup closes the SQL producer fence before resolving an uncertain publication. Confirmed retained snapshots survive VM destruction and are deleted only at retention expiry. Partial/uncommitted objects are physically deleted independently; ambiguous writes remain journaled and retain financial holds until cleanup can be proved. Secret-bearing/read-only-cache jobs produce metadata-only SDK snapshots.

## Local checks

From the repository root:

```sh
node_modules/.bin/tsc --noEmit -p packages/execution/hosted/tsconfig.json
node packages/execution/hosted/build.mjs
node_modules/.bin/vitest run tests/high-level/execution-remote-host.test.ts --config workers/hosted/vitest.config.ts
node_modules/.bin/vitest run tests/high-level/execution-hosted-files.test.ts
```

These are isolated local checks. Real Container lifecycle/UID/firewall enforcement, pinned DNS and HTTPS interception, measured resource limits, production use of the SDK binding snapshot transport, and end-to-end provider execution still require genuine provider acceptance. No deployment or Cloudflare account mutation is part of these checks.
