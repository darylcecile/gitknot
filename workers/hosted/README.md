# GitKnot remote hosted execution account

This Worker executes one frozen hosted attempt using the real **`@cloudflare/ci@0.2.0` → `@cloudflare/sandbox@0.12.1`** pipeline. Its only authority is the signed `RemoteAttemptGrant` and that attempt's callback capability. See [`packages/execution/REMOTE.md`](../../packages/execution/REMOTE.md) for the cross-account contract.

## Entrypoint and bindings

`src/index.ts` exports the authenticated HTTP handler, `HostedAttemptWorkflow`, `RemoteAttemptController`, `HostedSandbox`, and the pinned SDK's `ContainerProxy`.

Required bindings:

- `HOSTED_WORKFLOW` → `HostedAttemptWorkflow`
- `HOSTED_ATTEMPTS` → SQLite-backed `RemoteAttemptController`
- `SANDBOX` → SQLite-backed `HostedSandbox`, with a Container using the measured digest-pinned image
- `BACKUP_BUCKET` → private **ephemeral execution-account** R2
- `HOSTED_EXECUTOR_ID`, `HOSTED_CONTROL_KEY`, `HOSTED_CALLBACK_ORIGIN`, `HOSTED_PROFILES_JSON`, `ENVIRONMENT`

The binding type contains no trusted database, admission coordinator, vault, Git service, tenant ACL mirror, or general internal service key. HTTPS is mandatory. HTTP loopback is accepted only when **both** `ENVIRONMENT=test` and `HOSTED_TEST_ALLOW_LOOPBACK=true` are explicitly selected. There is no fallback executor.

`HOSTED_CALLBACK_ORIGIN` pins the exact control-plane origin (scheme, hostname and port), matching the CP's `HOSTED_REMOTE_EXECUTOR_JSON.callback_origin`. Grant acceptance and every callback/replay require the grant origin to match that configured origin. Missing or invalid configuration fails closed; paths, credentials, query strings and fragments are forbidden. Production requires HTTPS even if the test-loopback flag is present. Set the explicit loopback origin on both sides of isolated HTTP tests.

Infrastructure owns deployment configuration. Use the repository's `cf/config` deployment conventions, export `ContainerProxy`, enable `nodejs_compat`, provide the required R2 binding and Container image, and wire a scheduled handler to this Worker's `scheduled` export. The local bundle command does not provision or deploy anything.

## Execution and recovery

1. `/internal/hosted/attempts/:id/accept` verifies the shared signature and journals the exact grant before acknowledgement. Durable nonces reject wire replay; grant digests reject changed retries. A sharded reaper index is written before deterministic Workflow creation. Workflow parameters contain only the attempt ID, generation, and grant digest.
2. `runSdkJob` calls `prepareSource` **inside the real CI step**. The attempt DO consumes its one-shot claim before `begin`. The runtime is armed only after CP returns `execute:true` with the pinned checkout capability and a valid lease. A lost response or uncertain replay cannot reissue execution. Only the transient GitKnot checkout capability reaches checkout; callback/control/provider credentials never enter the VM.
3. The SDK Sandbox startup path is wrapped by a synced launch claim and a single-use raw `ctx.container.start` gate. A stopped, failed-start, or sealed ID cannot boot another VM. Public SDK operations and returned file streams remain journaled until settled/drained. The unused SDK preview/tunnel/background-version start hook is replaced by explicit pinned-toolchain verification.
4. Root prepares exact source, restores only declared dependency paths, verifies the pinned tree, and restores checksummed declared inputs. Whole-runner CI caching is disabled. Verification always runs.
5. Each command has a durable process claim and a second `mkdir` execution fence inside the VM. A root-owned supervisor uses a detached process group, uid/gid 10000, cleared groups/capabilities, `no-new-privileges`, hard descriptor/process limits, bounded combined logs, a whole-job deadline and a renewable **absolute** lease watchdog. Step environment values are supplied only after privilege drop. Kernel exit code/signal evidence is recorded separately from deadline, quota and infrastructure failure.
6. Per-file stateful redaction happens in Workflow memory before sanitized chunks enter the durable callback journal. Lost acknowledgements replay the same sequence/content. Full failure logs are retained up to the declared quota; SDK previews contain only a log-manifest reference. Secret values and redaction carry never become Workflow checkpoints. Typed outputs and file archives are inspected after job processes stop.
7. The real SDK snapshots a root-owned sanitized directory. Secret-bearing and read-only-cache jobs receive metadata-only snapshots. Checksummed archive/metadata parts are copied to retained CP storage through signed binary callbacks. Signed query fields bind the required snapshot headers. Restore imports and new SDK backups use per-grant physical R2 prefixes; all writes are tracked before bytes.
8. Normalized drafts are durable before the SDK can checkpoint. A second guard at the real Workflow step boundary enforces persistence even when CI swallows a `destroy()` error, and replaces SDK exceptions with fixed sanitized failures. Final completion is independently fenced by CP. Destruction first seals the allocation, stops job process groups, invokes SDK destruction, checks `ctx.container.running === false`, waits for outstanding operations, deletes every tracked R2 object, and verifies both object absence and an empty runtime prefix. A pre-cleanup draft with an unconfirmed process stop is upgraded only using these actual destruction facts before CP checkpointing.

Attempt alarms, SDK-compatible runtime alarm schedules, and 16 small reaper-index objects independently reconcile abandoned allocations. A timed-out wait is **not** cancellation of an SDK/R2 operation. Unresolved operations, including an ambiguous R2 write, remain `in_flight`; their capacity cannot be certified destroyed by elapsed time or a guessed receipt. Tombstones remain durable. Status/cancel responses bind a fresh challenge, producer, deadline, logical runtime and actual Sandbox DO ID.

## Image and network boundary

`Dockerfile` extends an explicitly digest-pinned Sandbox 0.12.1 base and preserves its entrypoint. The final image must be measured and digest-pinned in the admitted profile. Root installs owner-based IPv4/IPv6 firewall rules before running code: uid 10000 cannot contact local SDK/control ports or non-HTTP endpoints; DNS is restricted to configured platform resolvers. The image fails closed if these rules cannot be installed.

`enableInternet=false`, `interceptHttps=true`, and a catch-all outbound handler enforce exact hosts and attempt-wide request/body byte budgets. Every permitted HTTP(S) request traverses that handler; redirects are not followed by the trusted proxy. No platform credential is added to a customer request.

## Local verification

From the repository root, using installed dependencies:

```sh
node workers/hosted/build.mjs
node_modules/.bin/tsc --noEmit -p workers/hosted/tsconfig.json
node_modules/.bin/vitest run --config workers/hosted/vitest.config.ts
node_modules/.bin/vitest run tests/high-level/execution-hosted-files.test.ts
```

The isolated HTTP tests use separate CP/execution state and actual request signatures. They inject an explicitly **unavailable** physical Container boundary; the real CI provider step and the pinned Sandbox startup API are exercised without fabricating a successful VM execution. They cover lost replies/replay, immutable generations, challenge binding, full redacted failure chunks, pending-operation fencing, actual fixture-object deletion, checksum/stream quotas and snapshot signature identity.

**Provider acceptance remains unrun:** real Container startup/teardown, uid and firewall enforcement (including `CAP_NET_ADMIN` and IPv6), exact pinned-runtime DNS behavior, HTTPS interception/CA trust, resource limits and measurements, production use of the SDK's `localBucket:true` transfer path, and complete cross-account Git checkout/CI/snapshot execution require a genuine provider run. The SDK documents `localBucket:true` as the binding transport used for local development; this implementation reuses that real transport, and does not treat local tests as production acceptance evidence.

## Researched references

- Installed `node_modules/@cloudflare/ci/src/{pipeline/ci-workflow,ci/capabilities,ci/runners/sandbox}.ts`, version 0.2.0.
- Installed Sandbox 0.12.1 `dist/sandbox-DKG3H156.js` and its actual Container dependency: configuration, startup/retry, process, backup, stream and destroy paths.
- [Sandbox 0.x outbound controls](https://developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/)
- [Sandbox 0.x backup API](https://developers.cloudflare.com/sandbox/sdk/api/backups/)
- [Container outbound controls](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
- [Workflow triggering and deterministic IDs](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
- [Workflow retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [SQLite durable storage and output gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
