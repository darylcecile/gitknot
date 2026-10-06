# Customer-owned runner protocol v1

This is the exact portable client/server integration contract. All production traffic is outbound HTTPS to a GitKnot API origin (default `https://api.gitknot.com`). JSON uses snake_case and UTC RFC3339 timestamps. Explicit loopback HTTP is available only for local development/tests. Neither manifests nor workspaces contain infrastructure credentials.

## Enrollment and machine identity

### Durable credential exchange v1 (client/server integration)

Registration and rotation require `exchange: {version:1, id:'rce_<32 lowercase hex>', nonce:'<32 random bytes as canonical base64url, no padding>', expected_generation}`. Registration uses expected generation `0`; rotation uses the saved current credential generation. The client atomically persists the complete exact request, old/enrollment secret, and **secret 256-bit nonce** in an owner-only `<config>.exchange.json` before sending it. It retains that journal until the verified new configuration is fsynced. Retries and `gitknot runner recover --config FILE` reuse the same exchange; they never generate a second operation identity after an ambiguous response.

`@gitknot/runner/credential-exchange` exports the infrastructure-neutral schema and `deriveRunnerCredential`. Both sides derive `gkt_<base64url(32 bytes)>` with HKDF-SHA-256: IKM is UTF-8 enrollment token / old machine token; salt is the decoded nonce; info is canonical JSON `{protocol:'gitknot.runner-credential-exchange.v1',api_origin,operation,subject,exchange_id,generation,request_digest}`. `operation` is `register` or `rotate`; `subject` is `enrollment` or the immutable runner ID; `generation = expected_generation + 1`; `request_digest` is canonical JSON SHA-256 of `{name,capabilities,slots,disposable}` for register, and `{}` for rotate. API origin is the configured canonical origin, including scheme and port. Use the shared helper rather than duplicating the derivation.

The server atomically stores exchange ID, exact request digest, **nonce hash**, old/enrollment credential hash, new credential hash/generation, and stable nonsecret response metadata alongside enrollment consumption or rotation. It stores neither nonce nor credential plaintext. Responses include `exchange_id`, `credential_generation`, `machine_token`, and the original `credential_expires_at` (plus registration metadata). An exact retry may authenticate with the retired credential **only for the matching exchange**, nonce hash, original request, and expected generation. Recompute the same credential from the presented old secret and nonce. A changed request/nonce conflicts; subsequent rotation, independent revocation, account/pool disablement, or credential expiry prevents recovery. Retired credentials do not regain ordinary API access. The route must support this recovery before generic authentication rejects the retired bearer; ordinary idempotency middleware is not the credential exchange.

Transient client journals live outside workspaces and are erased after durable installation. No exchange nonce, enrollment secret, or machine token enters jobs, manifests, logs, artifacts, audit payloads, or server plaintext replay storage. These fields are required for the new protocol; there is no fallback to retrying a nonrecoverable one-time credential operation.

| Request | Body | Response |
| --- | --- | --- |
| `POST /v1/runner-enrollments` (owner bearer token) | `{pool_id, expires_in_seconds?}` | `{id, pool_id, enrollment_token, expires_at}` |
| `POST /v1/runners/register` (no bearer token) | `{enrollment_token, name, capabilities, slots: 1, disposable}` | `RunnerRegistration` below |
| `POST /v1/runners/:id/heartbeat` (machine bearer token) | `{pool_id, capabilities, available_slots, active_attempts: [{attempt_id,generation}]}` | `{status: 'active'|'revoked', cancel_attempt_ids?: string[]}` |
| `POST /v1/runners/:id/poll` (machine bearer token) | `{pool_id, capabilities, available_slots: 1, wait_seconds: 25}` | `{assignment: Assignment|null, retry_after_seconds?: number}`; `204` is also an empty poll |
| `POST /v1/runners/:id/rotate` (machine bearer token) | `{}` | `{machine_token, credential_expires_at}` |

`capabilities` is `{os: 'linux'|'darwin'|'win32', arch: 'x64'|'arm64', toolchains: {[alias]: fingerprint}, labels: string[]}`. A fingerprint comes from the compiler's canonical toolchain descriptor, verified against the actual host tools. Registration consumes the enrollment exactly once. Rotation atomically invalidates the old machine token. Credentials are stored in an owner-only directory outside every job/source workspace.

```ts
interface RunnerRegistration {
  runner_id: string;
  pool_id: string;
  pool_name?: string; // optional alias; a compiled pool:<stable-pool-id> producer also resolves the pool identity
  account_id: string;
  repository_ids: string[]; // authoritative allowed repositories, never another tenant
  trust: 'trusted' | 'untrusted';
  disposable: boolean;
  machine_token: string;
  credential_expires_at: string;
  heartbeat_interval_seconds: number; // normally 15
  poll_timeout_seconds: number; // normally 25; at most 50
}
interface Assignment {
  attempt_id: string;
  run_id: string;
  job_id: string;
  generation: number;
  lease_token: string; // scoped to runner + attempt + generation
  lease_expires_at: string;
  deadline_at: string; // includes checkout, execution, uploads, and cleanup
  manifest: RunManifest; // @gitknot/workflows; digest checked before executing
  source: {url: string; commit: string; token?: string}; // HTTPS GitKnot remote, no URL credentials
  inputs?: Array<{
    job_id: string; name: string; type: 'artifact'|'string'|'number'|'boolean'|'json';
    digest: string; size_bytes: number; download_path: string;
  }>;
  variables?: Record<string, string>;
  approved_environment?: {name: string; manifest_digest: string; commit: string};
}
```

`download_path` is an API-relative `/v1/attempts/:id/...` path, never a provider URL. Source tokens are short-lived GitKnot read credentials; they are passed to Git using a temporary askpass helper outside the checkout and removed before commands start. The runner strips inherited Git configuration, disables hooks/submodules, fetches the exact object, verifies `HEAD`, and creates separate clean job directories.

## Attempt calls and fencing

Every attempt call uses the machine bearer token plus `{runner_id, generation, lease_token}` in its JSON body (or matching headers for binary downloads). The server verifies machine revocation, repository/pool scope, generation, lease expiry, absolute deadline, and cancellation **on each request**, including blob reads/uploads. A lease extension is valid only when returned by the authenticated heartbeat. `401`, `403`, `404`, `409` (`attempt_fenced`), or `410` fence the client; it stops and never publishes a late completion. `429`/`5xx`/network failures are retried within the current lease/deadline; they never extend it locally.

| Request | Additional body | Response |
| --- | --- | --- |
| `POST /v1/attempts/:id/heartbeat` | `{}` | `{status:'active'|'cancelled'|'revoked'|'expired', lease_expires_at?:string}` |
| `POST /v1/attempts/:id/secrets` | `{step_id, names:string[]}` | `{values:Record<string,string>, expires_at:string}`; only the named step's authorized declared secrets |
| `POST /v1/attempts/:id/logs` | `{sequence, digest, size_bytes, data_base64}` | `{accepted:true, sequence, digest}` |
| `POST /v1/attempts/:id/outputs` | `{name, kind:'artifact'|'report'|'value', sequence, final, digest, size_bytes, data_base64, media_type, retention_seconds}` | `{accepted:true, name, sequence, digest}` |
| `POST /v1/attempts/:id/complete` | `{receipt, receipt_digest}` | `{accepted:true, receipt_digest}` |
| `POST /v1/attempts/:id/terminated` | `{termination, termination_digest}` | `{accepted:true, termination_digest}`; cleanup-only acknowledgement, never artifact/verification publication |

Digests are `sha256:<lowercase hex>`. Chunks are numbered from zero; log chunks have one attempt-wide sequence. Output chunks are numbered per output name. Digest and size refer to the decoded bytes. Retries with the same identity and checksum are successful duplicates; a changed payload is a conflict. Limits from `manifest.limits` are enforced while streaming. Log masking is stateful across chunks and occurs before durable disk writes/uploads. Artifacts are deterministic GitKnot file archives (`application/vnd.gitknot.files+ndjson`), preserving relative names/modes and bytes with no traversal, links, credentials, or `.git` metadata. The first line is `{"format":"gitknot.files","version":1}`; subsequent lines are `{path,mode,sequence,final,data_base64}` (canonical sorted keys, 48 KiB decoded file chunks, sequence per file). Value/report outputs have their declared content type.

Input downloads send `X-GitKnot-Runner`, `X-GitKnot-Generation`, and `X-GitKnot-Lease` in addition to the machine bearer token. The runner verifies size and digest before exposing inputs to commands. Input/output identity includes repository, source commit, manifest digest, job, attempt and trust lineage; the server must validate those bindings rather than trust a client-supplied name.

`receipt` is `{version:1, attempt_id, run_id, job_id, runner_id, generation, manifest_digest, commit, toolchain_fingerprint, outcome, started_at, finished_at, exit_code, signal, reason, logs:[{sequence,digest,size_bytes}], outputs:[{name,kind,digest,size_bytes,chunks}], steps:[{id,outcome,exit_code,signal}], cleanup_confirmed:true}`. Outcomes are `passed`, `failed`, `dependency_blocked`, `cancelled`, `timed_out`, or `not_applicable`. A command failure is not an infrastructure success. A success requires every command, output/report check, and cleanup to succeed. The receipt digest is canonical JSON SHA-256. The client atomically persists a redacted receipt before completion and replays the exact receipt after restart; it never reruns an uncertain attempt. The server compares duplicate receipts and publishes verification/outputs atomically only for the current live attempt.

`termination` is `{version:1, attempt_id, runner_id, generation, manifest_digest, commit, finished_at, cleanup_confirmed:true}`. After fencing, the runner persists this minimal cleanup receipt and sends it only to `/terminated`. The server matches the original identity/generation and outstanding cancellation, records termination for admission/cleanup reconciliation, and **does not accept outputs or verification through this route**. Revoked machine authentication may reject the acknowledgement; the runner retains it for reconciliation rather than claiming server-confirmed cleanup. The existing execution controller's `confirmCustomerTermination` is the intended server integration point.

## Lifecycle and isolation

**Credential boundary (required):** remote runners must configure `isolation` in their private local configuration. There is no same-user native fallback. Supported modes are a digest-pinned `oci` container (only the job tree/home/immutable input mount is exposed, never the daemon socket), `posix_user` (root supervisor, separate dedicated unprivileged job UID/GID), and `windows_user` (service supervisor, distinct batch-logon user and a kill-on-close Windows Job Object). The supervisor alone handles registration, polling, Git source credentials, broker/API calls, archives, journals and receipts. Job processes cannot traverse supervisor state, inherit its credentials/configuration, or inspect its process memory through the job identity/namespace. Merely placing a file outside a workspace is insufficient.

Local isolation configurations are `{type:'oci', image:'sha256:<image-id>'|'<image>@sha256:<digest>', engine:'docker'|'podman', network:'none'|'bridge', cpus?, memory_mb?, pids?}`, `{type:'posix_user', uid, gid}`, or `{type:'windows_user', credential_file:'C:\\private\\job-user.json'}`. Windows credential input is `{username,domain,password}` for a dedicated nonadministrator batch-logon account and remains supervisor-only. A missing or unavailable isolation backend blocks execution before any repository code. No isolation option enters the public receipt, which retains its existing fields. Intermediate outputs are snapshotted by a credentialless process inside the job boundary before the supervisor reads them, preventing symlink-swap races from reading supervisor files. Cache/source index checks happen before repository code; no supervisor Git command reads job-modified `.git` configuration afterward. Linux's privileged `setpriv` bootstrap receives only a clean supervisor environment; workflow loader settings are applied after dropping identity/capabilities.

Container identities are journaled **before** creation; removal and stopped state are verified before publishing a completion. Containers have private PID/IPC namespaces, dropped capabilities, no-new-privileges, read-only image roots, bounded resources, no healthcheck or raw log driver, and an independent root-owned in-container deadline. Job commands run as UID/GID `65532:65532`, so they cannot signal or inspect the root-owned deadline keeper. Direct engine exec supplies authoritative process exit status; no job-owned shim decides success. Native POSIX teardown additionally sweeps the dedicated UID, covering double-fork/`setsid` orphans; a credentialless watchdog performs the same sweep if the supervisor disappears. Run the native supervisor under a real init/service manager. Windows runs as a LocalSystem service in session zero, creates a private job-user window station/desktop, creates child processes suspended and attaches them to a non-breakaway Job Object before resuming. Closing the supervisor helper's handle kills descendants even if their parent exited; a dedicated-SID sweep also removes broker-created orphans such as WMI launches.

Default capacity is one slot. Machine/attempt heartbeats run during checkout, commands, uploads, and cleanup. Fencing, expiry and deadlines stop the selected isolation backend, then verify cleanup before a receipt becomes publishable. Supervisor subprocesses use detached POSIX process groups or Windows `taskkill /T` followed by `/F`; customer job teardown additionally destroys its OCI container, sweeps its dedicated POSIX UID, or terminates its native Windows Job Object and dedicated SID. Persistent hosts may execute only trusted source. An untrusted/fork assignment requires a pool, registration and assignment all compatible with disposable execution; the runner consumes one assignment and exits so the customer supervisor can destroy the VM. The server must atomically consume a disposable registration's assignment eligibility on its first lease: its remaining credential authority is restricted to that attempt, with no subsequent poll assignment. A directory is not a sandbox.

The runner keeps its own private journal and lock outside workspaces. Interrupted attempts are not resumed as shell processes: on restart the journal is reconciled and only already-finished receipts are replayed. Attempt publication never assumes that merely ending a long poll or orchestration instance terminates work.

## Integration requirements

The workflow-control implementation owns these routes, enrollment hashing/one-time consumption, scope checks, heartbeat/lease state, matching/fairness, log/output storage, secret-broker authorization, and atomic receipt acceptance. `packages/runner/src/index.ts` exports protocol types, `RunnerClient`, `runRunner`, `registerRunner`, `rotateRunnerCredential`, and local execution helpers. CLI auth uses `/v1/tokens/current`, `/v1/auth/login`, `/v1/auth/login/mfa`, and `/v1/auth/logout`, matching the identity module; see `docs/cli.md` for the human/API command surface and reproduction endpoint.

Isolation references: [Node 24 child-process uid/gid and stdio](https://nodejs.org/docs/latest-v24.x/api/child_process.html), [libuv privilege-drop implementation](https://github.com/libuv/libuv/blob/v1.x/src/unix/process.c), [Docker namespace/capability/resource controls](https://docs.docker.com/reference/cli/docker/container/run/), [Windows Job Objects and non-breakaway descendants](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [CreateProcessAsUser and explicit handle inheritance](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw). The high-level suite runs the actual OCI boundary and a privileged native Linux supervisor inside a local disposable test container; Windows service acceptance must run on a Windows LocalSystem host, and is not represented as passing by Linux/macOS tests.

### Parent integration checkpoints

- Public completion and termination payloads remain exactly as specified above. Local isolation configuration and allocation journals do not add fields to portable completion receipts.
- `AttemptMachine.complete` already checks current generation/producer/plan identity, active repository/actor, cancellation, lease and absolute deadline; its final guarded SQL repeats the live-attempt deadline predicates. Duplicate identical receipts are idempotent reads, not a second publication. The execution control-plane high-level suite verifies duplicate dispatch/receipts, credential rotation, cross-tenant denial and rejection of late uploads.
- The public `/v1/attempts/:id/terminated` route and private executor forwarding must invoke `confirmCustomerTermination` with the checked canonical termination digest. Until this is connected, client termination receipts remain durably pending and the server must retain unconfirmed cleanup state.
- A disposable runner's first assignment must atomically exclude every other attempt for that machine, including completed historical attempts. The per-attempt slot gate in `AttemptMachine.assign` must include a durable one-assignment condition (or consume a runner-level assignment ID in the same transaction); checking `disposable` and counting only active attempts is insufficient. The client also retains a durable local one-assignment tombstone and exits on restart without polling again, while its actual supervisor boundary protects credentials throughout execution.
- Native Windows runtime acceptance uses `GITKNOT_WINDOWS_EXECUTION_CREDENTIAL_FILE` in the platform-gated high-level scenario. The C# helper additionally compiles successfully against the .NET Framework-compatible compiler; that compile check does not substitute for Windows service execution.

### Global IDs and repository movement

Follow `docs/routing.md`. Runner and CLI traffic always addresses immutable GitKnot resource IDs at the configured API origin. Every heartbeat, poll, input/log/output request, cancellation, receipt replay and termination acknowledgement must resolve the resource's **current** repository placement on the server. The portable manifest and local receipt journal contain logical repository/run/attempt identity, not a database handle, cell, or shard URL.

Execution/orchestration owns the following creator handoffs:

| Creator | Registration before the create/intent commit or any `202` |
| --- | --- |
| `requestWorkflowOperation` in `packages/execution/src/operations.ts` | Register the operation ID as `workflow_operation`; register a newly reserved run/rerun ID as `run` **before** the `workflow_run_requests` batch. A run ID returned while planning is already globally routable. |
| `createRun` in `packages/execution/src/control-plane.ts` | Await `registerResourceLocator(env, {resource_id: runId, resource_type: 'run', repo_id})` before creating `workflow_runs`, including direct/background callers and supplied run IDs. |
| `queueJob` in the same module | Register each newly allocated attempt ID as `attempt` before committing the attempt/dispatch rows. |
| Runner-pool, enrollment and machine creators | Register `runner_pool`, `runner_enrollment`, and `runner` respectively. Repository-scoped records use their immutable repository ID; account-only records use `repo_id: null` and remain on the identity authority. |

Core mutation registration covers a recognized **main** event resource. It does not replace explicit registration of the extra pending run ID, or background IDs created through raw statement batches. Locator creation is awaited on the identity primary; an orphan locator is safe, an acknowledged ID whose locator arrives later is not.

When adapting a routed HTTP request or background resource lookup into an execution environment, preserve the original identity binding before replacing the metadata binding:

```ts
const runtimeEnv = {
  ...env,
  IDENTITY_DB: identityBinding(env),
  DB: currentRepositoryDatabase,
};
```

HTTP callers obtain the selected metadata binding with `requestDatabaseBinding(c)`. Background operations, run/attempt controllers and resumed orchestration must resolve their global ID again before reading/writing metadata after a wait or move. Credentials, principals, grants and account policy continue to use the identity primary; copied identity rows on a repository shard are only foreign-key material. Public routing runs before admission, authorization capture and idempotency. Cleanup/cancellation must reach the current attempt authority without authorizing a late output or verification publication.
