# Workflow execution

## Integration contracts

Owned exports are `registerWorkflowsRoutes(app)` and `registerRunnersRoutes(app)`; `workers/background/src/workflows.ts` exports `RunWorkflow`; `workers/execution/src/index.ts` exports the execution Worker, `AttemptController`, and the pinned `Sandbox` (`SANDBOX` alias). The Sandbox Worker also exports `ContainerProxy`; outbound interception requires that export.

`@gitknot/execution` contains portable state, scheduling, receipts, storage, and control-plane services. `@gitknot/execution/hosted` is Worker-only and imports the real `@cloudflare/ci` **0.2.0** and `@cloudflare/sandbox` **0.12.1**. Infrastructure owns deployment configuration and root dependency installation. No cloud resources are created by this package.

Required bindings: `DB`, `BLOBS`, `BACKUPS`, `ATTEMPTS`, `ADMISSION`, `DISPATCH`, `RUN_WORKFLOW`, `EXECUTOR`, `SECRETS`, `GIT_SERVICE`, `INTERNAL_SERVICE_KEY`. The background workflow requires a cross-script `SANDBOX` namespace pointing to the execution Worker's Sandbox class. The Sandbox and background require `BACKUP_BUCKET`. **The billing controller's `BACKUPS` binding must resolve to that same execution-snapshot bucket for `bucket: 'backups'` reservations and physical deletion; repository backup storage uses its separately scoped worker bindings.** `HOSTED_PROFILES_JSON` supplies measured, pinned image/toolchain profiles. All production integrations fail closed when absent.

The dispatch consumer calls `acceptDispatch(env, message.body)` and acknowledges only after it resolves. `sweepExecution(env)` republishes unaccepted dispatches, advances runs, reconciles attempts, and actually deletes expired objects/snapshots. The operations scheduled handler calls it for each current metadata placement. Run-related committed events call `handleWorkflowEvent(env, event)`; event deduplication remains in the operations event consumer. The native `merge_candidate.created` event carries its exact candidate/head/target/policy identity and complete changed-path inventory into planning.

Admission uses `reserveExecution`, `startExecution`, `settleExecution`, `cancelExecutionReservation`, and the storage reservation/commit/delete helpers from `@gitknot/billing`. The allocation grant uses a deterministic runtime ID; reservations and generation fences are durable. Settlement requires a sealed runtime destruction receipt or authenticated customer process-exit proof. Unreachable machines and outstanding SDK calls retain their capacity/financial holds. Cleanup/revocation never requires a new spending reservation. Storage commitments are independent of compute settlement.

Vault callers require their own `SECRETS_CLIENT_ID` and `SECRETS_CLIENT_KEY`; the general internal signing key cannot decrypt secrets. `selectSecretsForPlan` runs before freezing, its exact selection digests are bound into both the portable manifest configuration bundle and the execution plan, and `bindSecretPlan` binds each job selection to the final execution digest. `resolveAttemptSecrets` runs immediately before a declared step. Environment resolution holds a current accepted-target barrier while the broker reads the execution-owned runtime/approval views. Values remain in executor memory and are never Workflow step results.

### Read-only compiler preview adapters — billing/vault coordination

The validate (`{source}`), approved-workflow plan (`{commit_oid,ref,inputs}`), and stored-preview GET routes use these exported helpers:

```ts
// @gitknot/billing
type PreviewExecutionInput = Omit<ReserveExecutionInput, 'run_id' | 'attempt_id' | 'generation'>;
previewExecutionQuote(env: BillingBindings, input: PreviewExecutionInput): Promise<ExecutionQuotePreview>;

// @gitknot/secrets
previewSecretsForPlan(env: SecretsClientBindings, input: PlanSelectionInput): Promise<PlanSelectionPreview>;
```

Billing preview shares execution's current plan/entitlements, authoritative payer/repository, versioned prices, retention/grace and per-object headroom math. It returns the normal maximum-cost/rate fields plus `currency`, `payer_account_id`, subscription/plan and repository revisions, null runtime attribution, and `availability: {state:'eligible'|'unavailable', admission_required:true, reasons:[{code,message}]}`. It performs SELECTs only. An uninitialized billing account is priced under the same initial Free terms with a setup-required diagnostic. Missing prices/profiles or plans produce typed `price_unavailable` / `plan_unavailable` errors; an unavailable billing datastore produces `billing_preview_unavailable`. The HTTP preview records these as blocked diagnostics with unknown cost. No failure becomes a zero-cost quote or an approval.

Vault preview uses `POST /internal/vault/preview` authenticated with `vault.plan`. `PlanSelectionInput` is the existing current-principal/repository/workflow/commit/ref/trust/executor/environment/per-step-name contract. It returns `{selection_digest,context,steps}`; secret and variable entries contain selected scope/version metadata with all values omitted. Current use/read permissions and vault policies are checked through the shared selection implementation, followed by SELECT-only consistency checks. It creates only the standard anti-replay nonce, with no vault selection/binding/use record or decryption. Names address declared vault entries, never Worker environment bindings. Drafts lacking a real workflow identity retain unresolved workflow-scoped grant requirements.

The actual runtime path continues to use `selectSecretsForPlan`, `bindSecretPlan`, and execution admission. Vault machine release consumes execution's typed `loadRunnerAuthority` and `identityRunnerPredicate`, including locator-owned metadata, primary credentials, and the original attempt hash/generation. Both authority variants and stale-witness denial pass the vault integration cases.

### Composition requirements for infrastructure/parent

- API/background source inspection uses existing signed `GIT_SERVICE` routes `browse/raw` and `collaboration/inspect`; it needs no direct Artifacts binding. Candidate checkout uses `/repositories/:repo_id/candidates/:candidate_id.git`.
- Bind the execution-snapshot bucket to **both** `BACKUPS` and `BACKUP_BUCKET` in the execution Worker, and `BACKUP_BUCKET` in background. The Sandbox's explicit SDK `localBucket: true` path streams via the R2 binding; no R2 presigning credentials or provider tokens enter a VM.
- Configure **65,536 subrequests** for API/background/execution/hosted. The [current Workers Paid limit](https://developers.cloudflare.com/workers/platform/limits/#subrequests) defaults to 10,000 and is configurable up to 10 million. A 1-GiB same-account output needs 4,096 chunk reservations, puts and seals, followed by 4,096 checksum reads; inputs, logs, metadata and heartbeats add further bounded calls. The larger configured budget accommodates the full declared job envelope while streams retain backpressure.
- `RunWorkflow` uses at most 400 do/wait cycles per instance and durably continues under a new orchestration generation; a 1,024-step instance limit is sufficient. D1 remains the public authority through continuations and the seven-day total wait cap.
- `packages/execution/hosted/Dockerfile` produces the required non-root job user and root-owned toolchain descriptor while preserving the SDK entrypoint. Supply a digest-pinned Sandbox **0.12.1** base. Root-owned process supervision applies tenant environment variables only after privilege drop and enforces the absolute job/step deadline and authenticated lease. Owner-based IPv4/IPv6 firewall enforcement must prevent the job UID from reaching the SDK control ports. The final image digest is part of the external measured profile and compiler descriptor.
- Profile configuration must match the actual `cf/config` Container image reference, instance size and `maxInstances`. `linux-small` is limited to ≤1 vCPU, ≤6 GiB, ≤12 GB, ≤10 instances, and ≤one hour including all execution phases. Readiness requires real measurement evidence; no measurements are synthesized by builds.

### Optional isolated execution account

Select remote hosted execution in the trusted API/background/execution configuration with `HOSTED_REMOTE_EXECUTOR_JSON`:

```json
{
  "id": "exec-production-001",
  "origin": "https://hosted.gitknot.com",
  "callback_origin": "https://api.gitknot.com",
  "producer_id": "hosted:exec-production-001:linux-small",
  "key_binding": "HOSTED_CONTROL_KEY",
  "callback_key_binding": "HOSTED_CALLBACK_KEY_V1"
}
```

`HOSTED_CONTROL_KEY` is a dedicated platform transport secret shared only with the hosted control endpoint. It is **not** `INTERNAL_SERVICE_KEY` or a vault credential. Optional `callback_key_binding` selects a versioned `HOSTED_CALLBACK_KEY_*` retained only in the control plane; without it, `HOSTED_CALLBACK_KEY` or the existing internal key derives purpose-separated, attempt-scoped tokens. The selected binding is frozen in each dispatch journal so new grants can rotate while retries retain their original key. Keep referenced key versions available until their grants close. The remote producer is bound into the execution plan and portable manifest digest; branch rules can name it explicitly.

The trusted execution Worker retains `DB`, `ATTEMPTS`, `ADMISSION`, vault/Git access and public artifact storage. Remote mode does not require its `SANDBOX` or `BACKUP_BUCKET` bindings. It reserves and starts one deterministic logical remote allocation before sending the immutable grant. The remote account has no trusted D1 binding, SQL API, replicated ACL, admission binding, vault key, or general trusted service key.

Remote entry point: **`workers/hosted/src/index.ts`**, exports:

| Export | Binding/resource |
| --- | --- |
| Default Worker | Authenticated HTTPS origin in the remote execution account |
| `HostedAttemptWorkflow` | `HOSTED_WORKFLOW`, execution-account Workflow |
| `RemoteAttemptController` | `HOSTED_ATTEMPTS`, execution-account SQLite Durable Objects |
| `HostedSandbox` | `SANDBOX`, pinned Sandbox 0.12.1 Container application |
| `ContainerProxy` | Pinned SDK outbound proxy export |

Hosted bindings are `HOSTED_WORKFLOW`, `HOSTED_ATTEMPTS`, `SANDBOX`, ephemeral `BACKUP_BUCKET`, `HOSTED_EXECUTOR_ID`, `HOSTED_CONTROL_KEY`, **`HOSTED_CALLBACK_ORIGIN`**, `HOSTED_PROFILES_JSON`, and `ENVIRONMENT`. The callback origin must exactly match the control plane's configured `callback_origin`, including scheme and port. They do not include trusted application services or databases. The SDK runs from `HostedAttemptWorkflow`; the same-account `RunWorkflow` path remains available when remote configuration is absent. Both use the actual `runSdkJob` CI SDK bridge.

The API's registered `/internal/hosted/attempts/:id/:action` bridge follows the attempt's current resource locator and forwards the original signed HTTP request to the trusted execution Worker. Dedicated `x-gitknot-callback-*` signatures bind the stable URL, method and body digest independently of the authenticated inter-cell routing envelope. Streaming snapshot identity appears in both the signed URL and matching headers. A per-attempt capability and current authoritative generation, lease, deadline, actor/repository policy, producer and declared-resource checks authorize a fixed action set. No caller supplies SQL, an ACL or an actor. The host receives just-in-time GitKnot checkout and declared secret values through these capabilities; no callback or provider credential enters a job.

The control-plane reaper independently challenges the configured HTTPS executor. A callback's claimed `destroyed` boolean is insufficient: the authenticated response must prove the original grant digest, producer, deadline, logical runtime and concrete Sandbox ID, sealed destruction, zero in-flight SDK operations and deletion of every ephemeral object. Financial/capacity holds survive uncertain proof. Normalized completion drafts are durable before SDK checkpointing; callbacks arriving for an expired or superseded attempt cannot publish a result. The first verified teardown observation remains stable across settlement retries. Cancellation that atomically establishes that no remote dispatch journal ever existed produces an explicit zero-duration `never_allocated` receipt; it makes no provider-destruction claim.

Sanitized SDK snapshots are streamed with checksums/quotas to trusted `BLOBS` for retention and actual deletion. The remote bucket is only an ephemeral SDK staging area, including cache restore copies. Cache reads are scoped to the immutable repository/trust/producer/toolchain/declaration namespace, and cache hits never skip verification. Exact wire types and actions are maintained in [`packages/execution/REMOTE.md`](../packages/execution/REMOTE.md).

The callback custom domain's configured HTTP upload limit must accommodate the measured profile's maximum snapshot archive (cache allowance plus 16 MiB of archive overhead). [Cloudflare zone request-body limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits) are independent of Workers Paid limits. Validate this setting with the selected remote profile during provider acceptance; Worker streaming cannot override the zone's admission limit.

### HTTP request recovery

Compiler controls use these real repository-scoped endpoints:

- `POST /v1/repos/:repoId/workflows/validate` accepts `{source}` and optional `commit_oid`, `ref`, `inputs`, `pull_request_id`, or `merge_candidate_id`. It validates the submitted draft with the trusted module/toolchain catalog and current policy. Drafts have no approved definition commit; version-specific vault checks require an approved workflow identity.
- `POST /v1/repos/:repoId/workflows/:workflowId/plan` accepts the UI's `{commit_oid,ref,inputs}` plus optional PR/candidate IDs. It uses the actual approved definition and native source/candidate checks, and records an immutable preview.
- `GET /v1/repos/:repoId/plans/:planId` checks current authorization, accepted source, workflow/policy/placement and configuration versions before returning that snapshot. Strong digest ETags support conditional reads. Previews expire after **15 minutes**; expired metadata is collected after a one-day recovery window.

Both POSTs atomically commit the immutable preview, audit/source event and core idempotency receipt. Preview resources follow their repository's metadata placement. The response includes typed job/step/dependency/output structure, trusted toolchain fingerprints, current permission/configuration diagnostics, the repository-owner payer, immutable customer price versions and the maximum declared cost including infrastructure retries. Script bodies, input/environment values, vault values and platform cost rates are omitted. The private vault preview reads metadata without a selection issuance, binding or decryption. Pricing uses `previewExecutionQuote`, which creates no billing account, subscription commitment, reservation, runtime identity or executor. Every snapshot has `executable:false`; actual execution revalidates authority and admission.

Workflow run creation, reruns, cancellation, approval decisions and promotion use core `idempotency: {strategy: 'external', authorization, recover}`. A guarded `workflow_run_requests` intent, source event and core receipt commit before external work. The operation ID comes from `c.get('idempotency')?.operation_id`; a run's ID is derived from that operation, so retries/recovery cannot allocate another run. `RunWorkflow` materializes/reconciles that exact intent. A planning run is visible and cancellable through `/v1/runs/:id`; its cancellation fence prevents later materialization. `/v1/workflow-operations/:id` exposes the durable operation. Approval decisions retain their operation ID for exact recovery after an uncertain acknowledgment. Workflow/environment/pool/enrollment and artifact-promotion creation use core fenced mutation batches. Workflow request journals retain no credential values.

Run revisions advance across the planning-to-materialized handoff: creation compares the current planning operation's version and seeds the run above it in the same transaction as the creation event. Cancellation binds the reviewed run revision and its planning/materialized identity in the intent transaction. A scheduler or materialization race returns `412 revision_conflict` with no cancellation intent, event, audit or completion receipt committed; the client reviews the current version and confirms a new request. Cancellation responses use the run's version, including the creator's cancelled planning version, rather than the cancellation journal's separate counter. Continuation and concurrency-wait changes advance run revisions; unchanged wait polls and retries of an already-running planner do not churn them. Migration `098_workflow_run_revisions.sql` retires overlapping counters on older journal-backed runs. Context-backed execution batches use core's bounded, named metadata-fence deferral with the same frozen statements and authority guards.

Every source-derived execution representation requires its route capability on the target repository and `contents.read` on each additional immutable source repository. This covers run lists/details, planning and operation responses, previews, failed-trigger diagnostics, jobs, attempts, logs, artifacts, manifests, reproduction inputs, approvals, promotions and release history. Readbacks use fresh primary-backed identity sessions and current repository placement. Streamed responses recheck before reading and immediately before releasing each chunk. Responses are `private, no-store`; inaccessible sources are concealed with the same 404 boundary before ETags or conditional responses. Lists filter the complete audience and use reader/filter-bound encrypted scan cursors so continuation tokens do not reveal private resource IDs. Legacy source-derived records without provable retained audiences remain concealed.

`GET /v1/repos/:repoId/runs` validates and intersects `workflow_id`, `status` and `commit` before paging. It includes accepted planning requests and planning failures; those expose `requested_commit_sha`, `requested_source_ref` and `plan_digest:null`, without inventing a verified `commit_sha`. `commit` filters match this requested commit until materialization and the immutable run commit afterward. `GET /v1/runs/:id/logs` intersects `attempt_id` and `job_id`; a job selector must resolve unambiguously to the selected run's immutable job ID or logical job key. Foreign or absent jobs return no log rows. Reproduction separately uses `GET /v1/runs/:id/reproduce?job=<job_key>`; the incorrect `job_id` query is rejected.

`GET /v1/repos/:repoId/workflows/:workflowId/versions` reads authorized immutable version history. Runner pool discovery accepts `GET /v1/runner-pools?repo_id=<repo>` for repository-scoped `runners.manage`; optional `account_id` must match the current owner. Account-only discovery retains its account-wide capability requirement. Pool IDs are discovery hints, and each returned pool is read through its explicit locator authority.

`DELETE /v1/repos/:repoId/environments/:envId` retires an idle environment under `If-Match` and core idempotency. Active jobs, outstanding executor cleanup, held release barriers and live vault entries block deletion. The existing account-authority barrier serializes identity-primary vault writes with the repository-local tombstone transaction. Retirement invalidates idle approvals and pending publication requests while retaining immutable approval decisions, published releases and vault history. The same committed request recovers its 204 result; fresh plans, promotions and edits cannot reactivate the retired environment. Environment detail reads retain `state:deleted` metadata, and lists default to active environments with explicit `state=deleted|all` history views. Migration `100_execution_surface_contracts.sql` adds this lifecycle and frozen failed-trigger audience metadata.

Checkout credentials retain their deterministic retry identity, original user/authentication revision, MFA and parent credential. Initial issuance appends `federationCredentialStatements`; retries preserve the existing credential and SSO grant. On a separate metadata shard, the identity-primary credential preparation precedes a fenced attempt publication, and an unpublished capability is revoked. Reproduction uses `prepareDerivedCredential` and commits every returned statement with its authority guards and source event. Current actors retain the federation-restricted account scope. Approved workflow versions and environment approvals retain the approving credential ID; current MFA/SSO assurance and revocation are rechecked before protected execution or release. `secret_environment_authorizations` exposes `approver_credential_id` and `approver_mfa` alongside the exact artifact, commit, plan, destination and policy binding.

Public receipt routes belong to execution: `/v1/attempts/:id/{heartbeat,logs,outputs,secrets,complete,terminated}` and declared input downloads. Machine routes are `/v1/runners/{register,:id/poll,:id/heartbeat,:id/rotate}`. Authorized reads include `GET /v1/runs/:id/manifest` and `GET /v1/runners/:id`. Logical job/step/output identifiers use the shared workflow schema, including leading underscores; global resource IDs retain their strict prefixes.

### Runner exchanges, storage authority and cleanup

Registration and rotation use the shared `@gitknot/runner/credential-exchange` contract: `exchange: {version:1,id,nonce,expected_generation}`. The CLI durably stores the exact request and secret 256-bit nonce before sending. HKDF derives the same new machine credential from the presented enrollment/old credential, nonce, canonical API origin, operation, subject, generation and request digest. The server stores only hashes and stable nonsecret response metadata. Exact recorded exchanges recover after dropped acknowledgments; changed requests, changed nonces, subsequent rotations, independent revocation and expiry cannot revive an old credential.

`isRunnerProtocolRequest(request)` is exported by `apps/api/src/modules/runners.ts`. API composition bypasses generic principal authentication only for exact POST registration, rotation and cleanup-termination routes. Their handlers authenticate enrollment, exact exchange recovery or original allocation proof. Browser-origin/CSRF and rate limits still apply. Heartbeat, secrets, uploads and new assignment receive no such exemption.

Scope does not determine storage. Resource locators explicitly select `identity` or `repository` authority for a pool and its enrollment/runner children. Principals, core credentials, exchange journals and account-wide runner slots always use `IDENTITY_DB`; repository metadata contains no authoritative credential replica. Current repository ownership must still match the pool account, and a transfer requires re-enrollment. The private `/internal/execution/runners/metadata` protocol exposes only typed identity- and location-bound commands. Current machine/credential/account-epoch witnesses fence metadata acceptance after Worker I/O.

Disposable consumption is permanent after an assignment, including historical attempts. A leased slot remains held until verified termination, even after cancellation or a deadline. `/terminated` accepts only the original machine hash, generation, scoped lease and checksummed portable-manifest/commit receipt; it cannot renew a lease, issue work, upload outputs or publish a check. Cleanup-only proof remains usable after assignment retirement, account barriers and credential revocation. Confirmed completion closes slots and retires disposable credentials.

### Scheduling and placement

Manual requests may supply only manual-dispatch event types; that validation runs before every candidate/PR trust branch. Manual invocation executes or blocks, and trigger mismatch cannot manufacture a policy-authorized `not_applicable` result. Native candidate event inventories include rename source paths.

The actual collaboration producer event `pull_request.patch_updated` normalizes to `pull_request.updated`. Planning binds its exact retained patch ID, native evidence, fingerprint, head/base commits and source audience before compilation, and checks that same identity in the run-creation transaction. A stale or contradictory event cannot retarget the current head. Event/workflow/normalized-trigger identity deduplicates replay independently of later source changes. Explicit reruns retain their original immutable patch rather than substituting the latest PR patch.

`supersede: queue` preserves the compiler's stable concurrency group. Both planning and the atomic attempt insert wait for the preceding run, its cleanup and ordered approvals/releases. Approval waiting consumes no VM slot. Cancellation-style PR supersession also waits for fenced predecessor cleanup before admitting replacement work.

Run, attempt and workflow-operation locators are registered before their D1 intent or acknowledgment. Metadata environments preserve `identityAuthorityBindings(env)` and explicit physical descriptors; JavaScript binding equality never establishes storage identity. `quiesceRepositoryExecution(env,repoId)` runs before movement/purge, retaining hosted teardown holds and distinguishing unreachable customer machines from confirmed termination. Live hosted runtimes are reconciled at their original placement before cutover.

## SDK boundary and researched sources

Source inspected from the actual npm tarballs, not a newer API: `@cloudflare/ci@0.2.0` (`5e2dc159a22fb8ebb4411336ad7a36dde6941e36`) and `@cloudflare/sandbox@0.12.1` (`41c68a5365fde192aba836ef096110be3f47d13f`). CI 0.2.0's public `CIWorkflow` uses a `SandboxRunner`, returns raw successful logs, returns only failure previews, snapshots successful workspaces, swallows destruction failures, and caches entire successful runners. The adapter must harden those boundaries before the SDK's `step.do` can checkpoint.

- [CI runner implementation](https://cdn.jsdelivr.net/gh/cloudflare/ci@fbbc2902c07c8ac89612f915f28c58c9b0941dbd/src/ci/runners/sandbox.ts)
- [CI pipeline](https://cdn.jsdelivr.net/gh/cloudflare/ci@fbbc2902c07c8ac89612f915f28c58c9b0941dbd/src/pipeline/ci-workflow.ts)
- [Sandbox 0.x outbound controls](https://developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/)
- [Container outbound controls](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
- [Workflow waits/retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)

SDK-supported controls are `enableInternet = false`, `interceptHttps = true`, named outbound handlers, and `setOutboundHandler`. Outbound request/response bytes and request counts are enforced by GitKnot's trusted handler. `allowedHosts` alone can allow direct egress, so every allowed HTTP(S) request must traverse that handler. Non-HTTP traffic is denied. The 0.x documentation describes Cloudflare DNS exceptions, while current Container documentation describes intercepted DNS resolution; the exact pinned-runtime DNS behavior remains a real remote acceptance check.

## Remote acceptance

A profile is unavailable until its configuration includes real measurement evidence and a pinned image digest. Local high-level tests prove control-plane behavior; they cannot establish provider-side isolation, Container destruction, interception, startup latency, measured resource limits, or end-to-end Artifacts acceptance. These are explicit remote acceptance evidence, never represented as successful local execution.

## Source verification

The integrated execution changes pass **58 focused high-level tests under the root configuration**: 35 control-plane, preview, remote-control, runner-exchange and file-boundary scenarios, plus 23 isolated hosted HTTP/lifecycle scenarios. The repository TypeScript check, generated API project's offline `cf build`, and all three execution/background/hosted Worker bundles pass. The composed local-stack E2E rerun is tracked by the parent integration task; provider acceptance remains separate as described above.
