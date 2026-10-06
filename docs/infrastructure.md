# Infrastructure

GitKnot uses **`cf@1.0.0-beta.12`, Node 24, and `cf/config`**. No deployment, provider account lookup, login, provider resource creation, or DNS mutation is part of setup, development, config validation, or builds.

## Configuration and resource identity

`infra/environment.ts` defines `development`, `staging`, and `production`. Unknown modes fail. Each mode returns a complete configuration; there is no environment-block merging. The bounded initial topology has `cell-001`, `exec-001`, and `core-001`; `GITKNOT_<MODE>_SHARDS` adds up to eight explicit `DB_002`…`DB_008` bindings before another cell is needed. `IDENTITY_DB` points to the selected identity home's account-primary database; the initial home aliases `DB`, and additional metadata cells bind that existing shared authority. Local metadata copies do not authorize users or memberships.

Every `IDENTITY_DB` binding includes explicit `IDENTITY_CELL_ID` and `IDENTITY_SHARD_ID` physical-home descriptors. API/Git/background/execution/broker and their local wrappers derive both values and the D1 target from `identityStorage()`. The home currently occupies `core-001` in the selected identity cell. Core authority selection uses these descriptors even when workerd exposes two distinct binding objects for that same physical D1.

`CELL_BINDINGS_JSON` maps configured cell IDs to private API bindings used by the fixed `/internal/routing` protocol (`cell.authority` scope). `SHARD_BINDINGS_JSON`/`ROOT_SHARD_ID` select only configured metadata shards. Current repository reads and monotonic authority-fence installation use that protocol; a field in a caller's payload cannot choose SQL, manufacture an actor or replace an acknowledgement. The broker receives these bounded routing bindings so cross-repository authorization also reaches current authority. See [routing](routing.md) for the parent-owned request-routing and fence composition.

Every API declares the required `IDENTITY_KEYS_JSON` secret for identity derivation and keyed request fingerprints. Its version-to-key map is shared by all API cells in a mode; staging and production use independent material. Other Workers receive neither this ring nor `SESSION_KEY`. Request-owning D1 databases include migration `091_request_fingerprints.sql`, and movement preserves each request's fingerprint version, key ID and hash. Key distribution and retention are described in [operations](operations.md#identity-key-versions-and-request-fingerprints).

Local setup provisions a finite development-only operating pool and uses the actual billing allocator for its selected slice. `infra/local/capacity.ts` runs its narrow operator Worker against persisted local D1; it preserves existing financial controls and expiry. E2E capacity setup reuses this same path. The allowance is described in [setup](setup.md#finite-local-operating-allocation) and supplies no provider measurement or implicit staging/production funding.

Names include mode and cell: `gitknot-production-cell-001-core-001`, for example. Local D1 IDs are stable synthetic IDs derived from those names, using the v4-shaped UUID format accepted by cf beta.12, so the migration command and Vite/workerd open the same database. Remote D1 UUIDs come from ignored operator state at `.gitknot/infra/<mode>/<cell>/state.json`. State records resource IDs, names, accounts, observations, and desired-spec hashes, never credentials. An input state for another mode/cell is rejected.

`cloudflare.config.ts` at the root supplies account defaults to resource commands. Authoritative Worker configurations are:

| Worker | Config | Public ingress / role |
| --- | --- | --- |
| API/web | `apps/api/cloudflare.config.ts` | `gitknot.com`, `api.gitknot.com`; authenticated API and Vite Static Assets |
| Git | `workers/git/cloudflare.config.ts` | `git.gitknot.com`; HTTPS Git publication gate |
| Background | `workers/background/cloudflare.config.ts` | Private; scheduled sweepers, queues, `OperationWorkflow`, `RunWorkflow` |
| Execution control | `workers/execution/cloudflare.config.ts` | Trusted private control plane; `AttemptController`, `AdmissionController`; optional direct `Sandbox` |
| Remote hosted runtime | `workers/hosted/cloudflare.config.ts` | Optional authenticated execution-account HTTPS endpoint; `HostedAttemptWorkflow`, `RemoteAttemptController`, `HostedSandbox`, `ContainerProxy` |
| Secrets | `workers/secrets/cloudflare.config.ts` | Private broker only |
| Webhook transport | `infra/egress/cloudflare.config.ts` | Private DNS-pinned HTTPS transport in a separate Container pool |

Staging uses `staging.gitknot.com`, `api.staging.gitknot.com`, and `git.staging.gitknot.com`. Every Worker disables both `workersDev` and `previewUrls`. API/Git declare the product domains; optional remote hosted execution declares its explicitly configured machine endpoint. The existing `gitknot.com` zone and, in remote mode, the execution account's active origin zone are looked up by the explicit read-only resolution command. Custom-domain attachment belongs to a later explicit rollout, after Worker versions exist.

## Inventory

`npm run infra:plan` prints the complete offline inventory and desired policy bodies.

| Resource | Bindings / purpose |
| --- | --- |
| D1 directory | `DIRECTORY_DB`: resource-to-cell/shard/epoch routes |
| D1 identity primary | `IDENTITY_DB`: shared current accounts, credentials, membership and policy authority; initial home aliases `DB` |
| D1 core shards | `DB`, bounded `DB_00N`: authoritative identity, collaboration, operations, workflow and billing state |
| D1 search | `SEARCH_DB`: separate rebuildable FTS database; `ops/search/*.sql` never runs against a core shard |
| Private R2 | Trusted `BLOBS`/`BACKUPS`/Logpush; direct SDK snapshot bucket or a separate execution-account ephemeral bucket and hosted Logpush |
| Queues | `EVENTS`, `DISPATCH`, `WEBHOOK_DELIVERIES`, `MAIL_DELIVERIES`, `INDEX_EVENTS`, `METER_EVENTS`, `ARTIFACTS_EVENTS`, each with an independent DLQ |
| Workflows | Trusted `RUN_WORKFLOW` / `RunWorkflow`, `OPERATIONS` / `OperationWorkflow`; optional remote `HOSTED_WORKFLOW` / `HostedAttemptWorkflow` |
| SQLite DOs | `REPO_COORDINATOR`, `GIT_CONTAINERS`, `ADMISSION`, `ATTEMPTS`, `SANDBOX`, private egress pool |
| Artifacts | Opaque, mode/cell-specific `ARTIFACTS` namespace; no general-purpose canonical writer in a customer runtime |
| Mail | `EMAIL`, verified `mail.gitknot.com` or `mail.staging.gitknot.com`, bounded independent delivery queue |
| Observability | `METRICS` Analytics Engine datasets; Worker logs/traces; Logpush to its own private R2 bucket |

Queue retention is set to 14 days; durable source records support at least 30-day replay. Queue bodies contain IDs/object references. DLQs have no automatic destructive drain. Bucket policies disable public `r2.dev`, abort incomplete multipart uploads after one day, and bound trace/backup storage. Ordinary object/snapshot deletion is manifest-driven so retained LFS, reviews, and live cache references are not removed by broad bucket-age rules.

## Trusted and untrusted compute

The pinned hosted profile is `linux-small`: CI SDK **0.2.0**, Sandbox **0.12.1**, Linux/amd64, `standard-2` (1 vCPU / 6 GiB / 12 GB), `default` scheduling policy. Production has a hard **10-instance** cap; staging/development have 2. Trusted native Git uses a separate application and namespace capped at 3 production instances (1 staging/development). The webhook transport uses two `basic` instances and a 30-second idle shutdown. All three pools disable SSH.

The direct Sandbox build uses `packages/execution/hosted/Dockerfile`; the remote runtime uses `workers/hosted/Dockerfile`, which also installs its owner-based firewall support. Both build from the verified 0.12.1 base digest `sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5`, preserve the SDK entrypoint and use a non-root job identity/root-owned toolchain descriptor. Release validation requires the **final** image digest and measured profile evidence; `HOSTED_PROFILES_JSON` defaults to `[]` so absence of evidence cannot enable unmeasured paid work. Native images are built from reviewed Dockerfiles or selected by an explicit digest reference. Raw hosted Container logs are disabled; the executor performs redaction before durable log/checkpoint storage.

In direct mode, API/background/execution `BACKUP_BUCKET` targets the trusted-account SDK snapshot bucket. The API's private `billing.physical` endpoint can therefore verify and delete snapshots in their recorded cell. Billing's distinct `backups` and `snapshots` storage kinds resolve to repository `BACKUPS` and SDK `BACKUP_BUCKET` respectively; execution retains that same distinction. In remote mode these direct runtime bindings are absent: retained logs/outputs/sanitized snapshots go to trusted `BLOBS`, while only the hosted Worker binds its execution-account ephemeral `BACKUP_BUCKET`.

API/background/execution/hosted configure **65,536 subrequests per invocation** on Workers Paid. A 1-GiB direct output alone needs `4096 × (reserve RPC + R2.put + seal RPC) + 4096 × R2.get = 16,384` subrequests; declared inputs, logs, metadata and heartbeats add further calls. Cloudflare's [paid default is 10,000, configurable up to 10 million](https://developers.cloudflare.com/workers/platform/limits/#subrequests). CPU and product admission budgets remain separately configured.

Set `GITKNOT_<MODE>_HOSTED_EXECUTOR_FILE` to select the implemented remote hosted adapter. Its file follows `infra/hosted-executor.example.json` and pins executor ID, producer, HTTPS origin, API callback origin and the dedicated trusted control-key binding. The original one-account direct path remains available when the file is absent. Different trust/execution account IDs require remote configuration.

Optional `callback_key_binding` selects a `HOSTED_CALLBACK_KEY` or `HOSTED_CALLBACK_KEY_*` secret on trusted API/background/execution only. Absence keeps the existing `HOSTED_CALLBACK_KEY` default. Each dispatch retains its selected name; `HOSTED_PREVIOUS_KEY_BINDINGS` accepts bounded previous control and callback names so deterministic retries keep their original material.

The remote Worker receives exactly nine bindings: `HOSTED_WORKFLOW`, `HOSTED_ATTEMPTS`, `SANDBOX`, `BACKUP_BUCKET`, `HOSTED_EXECUTOR_ID`, `HOSTED_CONTROL_KEY`, `HOSTED_CALLBACK_ORIGIN`, `HOSTED_PROFILES_JSON`, and `ENVIRONMENT`. `HOSTED_CALLBACK_ORIGIN` pins every callback and durable replay to the trusted configuration's exact API origin. It receives no trusted D1, identity mirror, admission/vault/Git/API binding, callback master or general internal key. `workers/execution` stays in the trusted account; the API forwards authenticated attempt callbacks to it. Current generations, leases, declared resources, producer and independent signed status govern acceptance. The remote SDK/DO/reaper proves actual sealed cleanup before capacity/financial holds can settle.

A hosted Custom Domain must lie in an active zone owned by its execution account. A separately delegated sub-zone of `gitknot.com` requires Cloudflare's [Enterprise subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/). The plan verifies actual ownership and records the zone; it does not assume a domain owned by the trusted account can attach to another account's Worker.

The **trusted API callback Custom Domain's zone** must admit one binary snapshot archive of at least the selected cache allowance **plus 16 MiB**. This HTTP request-body setting is independent of the Workers plan and subrequest budget. Record the actual zone limit and verify a maximum-sized archive during provider acceptance; local streaming/build checks supply no measurement of that limit. See [request and response limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits).

## Build implementation

The Cloudflare Vite plugin **2.0.0-beta.sha-52b0dc0e9** implements dev/build. `infra/projects.ts` writes ignored project wrappers, each importing its owned `cloudflare.config.ts`. `scripts/build.ts` builds workspace artifacts, then runs **`cf build --mode <mode>`** per Worker. The Vite plugin takes web assets from `apps/web/dist` as its client/public input. `worker.assets` controls request routing only; no authored config has `assets.directory`.

The script assembles trusted `.cloudflare/output/v0/` with the API as `workers/default`. Remote hosted output is isolated under `.cloudflare/accounts/execution/.cloudflare/output/v0/`, with its own account config and default Worker. `.cloudflare/build-manifest.json` records both account roots; no root combines a trusted account ID with an execution-account Worker. All builds suppress provider credentials/remote development bindings. Dockerfile builds need Docker and their base images locally; cf does not upload them during build.

## Provisioning boundary

`infra/plan.ts` is offline by default. `--resolve` is an explicit authenticated **read-only** adapter over the installed cf resource CLI. It resolves the existing zone, exhausts supported resource pages, reads DNS/mail/ruleset observations, and records precise desired actions in a plan file. A failed/unrecognized response is an error, not an empty resource list.

`scripts/provision.ts --plan …` displays the plan. Adding `--apply` creates/adopts named D1/R2/Queues/Artifacts resources, reconciles D1 replication/queue retention/R2 storage class, merges owned bucket/WAF policies, onboards the sending domain and event subscriptions, verifies results, and atomically records state. It re-reads the exact zone/resource identities, reconciles uncertain creation results, keeps a local state lock, and preserves unrelated rules. Planning also observes existing Worker/DO/Workflow/Container IDs without creating versions. It does not deploy Workers, invoke remote migrations, delete resources, or change application routing epochs. Secrets and Logpush credentials have separate explicit file-based operations.

## Research and provider references

Checked 5 October 2026 against the installed package declarations and official documentation. Context7 was used for cf/config and Vite research; its quota was exhausted during later queries, which were checked against official API types/docs.

- [cf project execution/build semantics](https://developers.cloudflare.com/cf/projects/)
- [Typed configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Command discovery and JSON output](https://developers.cloudflare.com/cf/agents/)
- [Container images](https://developers.cloudflare.com/containers/guides/image-management/)
- [Rate-limit API and protocol-appropriate responses](https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/)
- [Email domain onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/)
- [Logpush to R2](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/r2/)
