# Operations

## Operating model

`infra/plan.ts` and `scripts/provision.ts` manage desired infrastructure and operator state. `OperationWorkflow` owns durable repository lifecycle work. Repository coordinators own publication fences, `AdmissionController` owns reservations, and `AttemptController`/Sandbox alarms own execution deadlines and cleanup. Resource provisioning never changes a repository's routing epoch.

The checked-in GitHub Actions workflow runs Node 24 typechecking, all-layout config validation, high-level/native Git tests, Playwright journeys, and separate direct/remote offline cf builds. The remote build uses `.github/fixtures/hosted-executor.json` and synthetic account IDs; those artifacts are configuration evidence only. It has no Cloudflare credentials or deploy step. Build artifacts include `.cloudflare/output/v0/`, optional execution-account output, the build manifest, saved image tarballs, and test reports. `cf build` does not run root package scripts, which is why `scripts/build.ts` explicitly builds workspaces before invoking cf.

Playwright evidence is uploaded from `.gitknot/e2e/*/report/` and `.gitknot/e2e/*/test-results/`, matching `playwright.config.ts`. The per-run state, `fixtures.json`, and local key files are outside these artifact paths.

## Before a first production rollout

These are operator evidence requirements for opening the service, not results of offline tests:

1. Resolve the existing `gitknot.com` zone and explicit production/staging accounts with `infra:plan --resolve`. Remote hosted mode also resolves the serving execution account's HTTPS-origin zone. Confirm all names, jurisdiction controls, plan entitlements, zone upload size, and private-service exposure.
2. Apply the reviewed resource plan separately. Preserve `.gitknot/infra/<mode>/<cell>/state.json` in controlled operator storage. Never infer success solely from a zero CLI exit status: the apply adapter performs read-back verification.
3. Apply production database schemas through a separately reviewed operator change. The repository's migration command remains local-only. Confirm authoritative databases contain no FTS virtual tables and the directory is the selected logical partition.
4. Provision independent mode-specific keys. Only the broker receives KEKs/service-client registry; only the API receives identity master keys. Background prepares identity mail through its authenticated `API` binding. The execution microVM receives only scoped attempt material from the broker.
5. Populate immutable billing prices, the cell's preallocated platform budget/capacity slice, and measured `HOSTED_PROFILES_JSON`. Admission must remain unavailable until these are authoritative. The ten-instance infrastructure cap is a maximum rate, not a customer spending ledger.
6. Pin the real native Git, Sandbox and webhook images by digest. Record the tested CI SDK 0.2.0 / Sandbox 0.12.1 / image combination and toolchain digest. Validate Artifact namespace write capabilities against real provider storage.
7. Complete email domain/DKIM/SPF/DMARC verification and sending-quota review. Confirm both security and notification senders work and signed provider status events update delivery/suppression state.
8. Configure Logpush with a bucket-scoped credential and confirm an actual delivery to the expected private R2 bucket. Analytics/observability data are operational signals; billing remains the durable ledger.
9. Exercise fresh-cell recovery, old-epoch write rejection, duplicate event replay, controller termination, budget races, and large Git/LFS round-trips. Record hashes, timestamps, versions and measured recovery duration.

`npm run check:config -- --mode production --release` checks resolved IDs, broker secret placement and digest-pinned configuration. It does not manufacture provider evidence. Only explicit, separately performed rollout commands can attach the configured custom domains, Workers/DO namespaces, queue consumers and Workflows to live resources.

### Build handoff

```sh
npm run build -- --mode production --save-images
npm run check:config -- --mode production --build
```

Keep `.cloudflare/output/v0/`, `.cloudflare/accounts/` when present, `.cloudflare/build-manifest.json`, and `.cloudflare/images/` together. The manifest identifies each owning account/output root; the hosted Worker is never included in a trusted-account root. Container `localReference` values refer to images in the build machine's Docker engine. Load saved tarballs on another machine before a later prebuilt rollout, verify their manifest hashes, and use the same mode and account root. Production image-reference configuration should use measured digest pins. There is no implicit upload or rollout in this handoff.

## Identity key versions and request fingerprints

`IDENTITY_KEYS_JSON` is required on every API cell. All cells within a mode must have identical version-to-key maps; staging and production use separate material. IDs are immutable, 1–32 ASCII letters/digits/`_`/`-`. Never assign different bytes to an existing ID.

1. Add a fresh version with at least 32 cryptographically random bytes encoded as base64url. Preserve every existing entry and leave `current` unchanged. A `SESSION_KEY`-only transition first adds `session-v1 = base64url(UTF8(existing SESSION_KEY))` with `current: "session-v1"`; it preserves the original derivation bytes.
2. Distribute the complete retained map to **all** API cells before activating the new version. Each cell's private secret file uses the same protected ring source, alongside its own vault-client identity. Provider secret-name read-back alone does not verify key bytes.
3. Change `current` only after distribution is complete. New requests use that version; retries use the original `fingerprint_key_id`. Keep `request_hash`, `fingerprint_version`, and `fingerprint_key_id` unchanged during movement, restore and recovery.
4. Retain old versions for every live, unresolved or restorable request and every remaining identity reference, including TOTP factors and identity actions. Retirement is governed by those references and recovery retention, not merely the active retry window. Missing historical keys keep requests closed rather than permitting another operation.

Apply `091_request_fingerprints.sql` to every request-owning D1 through the separately controlled schema rollout before enabling the corresponding request writers or moving requests there. It retires legacy unkeyed fingerprints while preserving operation references and deduplication tombstones. SQL cannot reconstruct protected fingerprints from discarded request bodies.

## Observe and diagnose

Record a GitKnot request ID, repository/run/attempt/operation ID, cell/shard, routing epoch, deployed version, and start/end time. Public failures expose GitKnot errors; restricted diagnostics retain provider context.

| Signal | Initial operational trigger | Response |
| --- | --- | --- |
| Metadata latency | reads >300 ms p95 or writes >700 ms p95 over representative load | Inspect query/index/primary saturation; reduce discretionary traffic before moving a hot shard |
| D1 growth | 6.5 GB or backup/import envelope reached earlier | Add capacity and run an evidenced shard move |
| Outbox oldest unpublished | >60 s sustained | Inspect dispatcher and queue acknowledgments; replay from durable source rows |
| Queue/DLQ | rising age, retry or dead-letter count | Isolate consumer/destination; retain original event IDs and inspect current authorization |
| Execution admission | >60 s p95 within paid/tested capacity | Check fair queue, runtime/profile availability, reservations and hard instance caps |
| Orphan/overdue runtime | any runtime after its deadline without destruction proof | Stop new paid work in that slice; reaper must verify shutdown before releasing holds |
| Git uncertain publication | any ambiguous accepted update | Keep repository writes fenced; reconcile canonical refs and transaction marker |
| Backup | missed cadence, missing manifest part or failed restore drill | Preserve retained copies; open a recovery incident; do not assert an RPO the evidence does not support |

Private background endpoints are signed with scope `operations.maintenance`: `/internal/operations/metrics`, `/internal/operations/sweep`, `/internal/operations/move`, `/internal/operations/move-recover`, and `/internal/operations/move-abort`. Recovery and abort take the immutable `{operation_id}`; rollback is available before the cutover decision. `infra/recovery/service.ts` exposes Worker-safe submission and recovery adapters. These are service-binding endpoints. A remote operator must use an explicitly configured authenticated operator gateway, or call the exported maintenance adapter inside a Worker with `BACKGROUND`; these endpoints are not published through workers.dev. The development router exposes them only through a loopback selector plus the normal signature verification.

Private API `/internal/routing` is reserved for the fixed `cell.authority` protocol: current repository metadata reads and authority-fence installation. Account access changes must finish all enrolled placement acknowledgements before reporting success. Background identity mail uses `/internal/mail/prepare-identity` with `mail.prepare-identity`; the API prepares it from current identity state and holds the sole identity master key.

Private API `/internal/billing/metadata` and `/internal/billing/physical` use `billing.metadata` and `billing.physical` scopes for routed financial metadata and physical storage checks. In direct mode the API has the local SDK `BACKUP_BUCKET` for the `snapshots` kind; `BACKUPS` remains the repository backup bucket. Remote ephemeral storage is managed by the hosted runtime, while retained remote objects use trusted `BLOBS`.

Physical movement also uses the existing peer Git Workers through `CELL_GIT_BINDINGS_JSON` and Billing's signed placement/admission endpoints. Setup includes the current API cell and the identity home in `CELL_BINDINGS_JSON`, so retained-source cleanup and account admission keep their recorded authority after routing moves. Account controllers stay at their durable home; each capacity controller stays with its allocated slice. The mode-scoped `BILLING_PLATFORM_SLICE_ID`, `BILLING_GIT_STORAGE_SLICE_ID`, and `BILLING_ESSENTIAL_SLICE_ID` settings select existing funded catalog slices. These bindings do not allocate provider resources or create financial capacity.

## Stop controls and cleanup

- Stop new paid execution by updating authoritative billing slice/account controls. `GITKNOT_<MODE>_EXECUTION_PAUSED=true` additionally builds a paused execution configuration. Budget verification failures already fail closed.
- Keep the private executor, broker revocation path, deadline alarms and reaper available. A completed Workflow or expired lease is not destruction proof.
- Preserve reservations for ambiguous allocations. Settle exactly once after measured allocation-to-destruction time and a verified teardown/never-started receipt.
- For a stuck native publisher, preserve the coordinator's fence and operation marker. Do not clear a lock simply because its deadline passed.
- For runaway storage, stop new reservations, retain live references, and let the manifest-based deletion worker confirm actual object deletion before releasing quota.

## Ingress and machine protocols

The owned rate-limit rules return deterministic JSON or text with HTTP 429, never an interactive browser challenge. The application supplies request-specific `Retry-After` and request IDs. The custom WAF rules exclude API/Git routes from Browser Integrity Check/security-level/Super Bot Fight Mode browser challenges while keeping explicit request controls.

Remote hosted callbacks have a separate bounded data-delivery rate, rather than sharing ordinary API-request limits. Accept traffic to the hosted endpoint is independently limited; status/cancellation and trusted cleanup callbacks retain their cleanup path. Every request still needs its correct dedicated control key or current attempt-scoped capability. Hosted WAF/rate rules are applied in its owning execution-account zone.

Check the trusted API callback domain's zone upload setting against **selected cache allowance + 16 MiB** before admitting remote snapshots. The snapshot archive is one binary HTTP request. Its zone admission limit is independent of the 65,536-subrequest Worker setting. Provider acceptance must demonstrate the selected maximum archive; offline configuration checks do not establish upload capacity.

Inspect pre-existing zone rules and plan-specific managed rules at rollout: an earlier custom challenge or a managed WAF challenge can still affect a machine client. Use block/rate-limit actions and narrowly scoped managed-rule overrides with recorded stock Git/CLI tests. Check actual request upload ceilings before raising `LIMITS_JSON.git.max_pack_bytes`; streaming does not bypass a zone's upload limit.

## Event and mail recovery

Queue messages are hints backed by committed sources. For consumer incidents, preserve the source event identity; recheck current membership/visibility before effects or email. Application redelivery creates a new delivery generation for the same event. `POST /v1/events/replay` accepts a bounded 30-day window and an authorized repository/webhook. Monitor resulting receipts and DLQ age rather than deleting a queue to make its graph look healthy.

Activity mail retains Collaboration's exact `source_revision` and `user_state` witness from `readInboxForDelivery`. The final identity-primary release transaction includes `inboxDeliveryUserStateGuards`, covering the original user/context, overlay, profile preference and complete subscription set. With split storage, the repository transaction first checks source versions and the send lease; the identity transaction makes the final authorization decision and verifies the lease deadline. A failed identity guard produces no `mail.release_authorized` receipt or provider send. A new attempt captures a new witness rather than reusing an earlier payload authorization.

Artifacts signals are a reconciliation aid. Subscribe account lifecycle events to the cell's `ARTIFACTS_EVENTS` queue and add repository-scoped pushed/token events as repositories are provisioned. The consumer must validate account/namespace/repository scope and tolerate duplicate/missed upstream signals; these signals never provide authenticated actor attribution or the primary publication journal.

Mail Sending domain/status subscriptions and account quotas are provider-specific setup. Keep staging sender/domain/status scope distinct from production. Security actions must rehydrate an unexpired identity action and produce the same token hash, rather than mailing data stored in a stale event payload.

## Configuration and state recovery

An interrupted resource apply may leave an existing resource whose ID was not recorded. Re-resolve exact names and rerun the same desired plan; the adapter adopts only matching identities. If `.state.json.lock` remains after a process crash, inspect its recorded PID and prove no apply process is still running before removing that local lock. Do not delete or recreate cloud resources to repair a missing local state file.

Never downgrade the cf/plugin beta without rebuilding and validating all three modes. Recheck provider limits with `npx tsx infra/recheck-limits.ts`; review changed source text before changing product caps. [Capacity](capacity.md) describes the measurement matrix; [recovery](recovery.md) describes restore gates.
