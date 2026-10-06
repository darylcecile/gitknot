# Git storage and publication

## Integration contract (implementation owners)

`@gitknot/git` owns the Artifacts adapter, publication types, policy schema,
internal client, and LFS service. `registerGitRoutes(app)` is exported from
`apps/api/src/modules/git.ts`. `workers/git/src/index.ts` exports the default
HTTPS gateway, `RepositoryCoordinator`, and the separate trusted
`GitContainer` class (`@cloudflare/containers` **0.3.7**, default scheduling
policy). Infrastructure owns `workers/git/cloudflare.config.ts`; bind
`GIT_CONTAINERS` to `GitContainer`, `REPO_COORDINATOR` to
`RepositoryCoordinator`, and `GIT_SERVICE` to the Git gateway's private service
binding. The gateway uses the Containers binding to reach native Git. Native
Git never shares a pool, disk, snapshot, credentials, or execution endpoint
with customer jobs. Image: `services/git/Dockerfile`, Node 24 / Linux.

### Current placement and streaming cell handoff

`workers/git/src/placement.ts` preserves `identityAuthorityBindings(originalEnv)`
before every metadata shard override and selects the resolved repository through
core `selectRepositoryDatabase(c, placement)`. `IDENTITY_DB`,
`IDENTITY_CELL_ID`, and `IDENTITY_SHARD_ID` travel together. Git never uses D1
object identity to infer a physical database or resource owner. Credentials,
account rules, signing principals, and account revisions are read from current
identity authority; repository policy and publication records use the selected
metadata shard.

Infrastructure must supply `CELL_GIT_BINDINGS_JSON`, a bounded cell-ID to binding
name map, with each `CELL_GIT_*` binding targeting that cell's Git Worker. The
existing `CELL_BINDINGS_JSON` API peers remain necessary for core repository
authority and account-fence RPCs. Every configured peer needs both bindings.

Public Git forwarding uses core's purpose-separated routing envelope at the
Git-only `/v1/repos/:repo_id/git-transport` endpoint. The signed query carries
the original Git path/query and exact `git-protocol`, `content-encoding`, and
`content-length` declarations. The credential, CSRF/precondition headers,
placement/epoch, nonce, hop count, and admission deadline use the core MAC. The
pack body is passed as the original stream; no public body clone, SHA buffer,
or 4 MiB private-RPC body path is involved. The destination consumes the nonce,
rereads name and placement, authenticates the actual credential, and applies
the normal native/LFS gate and streamed byte limits.

Stock Git's four-byte `0000` authentication probe is answered only after current
repository and push admission, with its exact bounded body verified. It creates
no publisher. This lets the subsequent real chunked pack reach quarantine; see
[Git `probe_rpc`](https://github.com/git/git/blob/v2.54.0/remote-curl.c#L879-L952).

`POST /internal/git/namespace` is a fixed, content-signed lookup of `{owner,name}`.
It reads current account slugs on the identity primary and current names/aliases
on bounded configured metadata placements. Retained source copies are discarded
unless their cell, shard, and epoch still match the directory. Current names
take precedence over historical aliases, and ambiguity fails closed. A source
repository's provider namespace resolves independently through the authenticated
`read-remote` broker when it lives in another cell; source ACLs are reread there.

`git_barrier_routes` is an immutable identity-primary `(repo_id,operation_id)`
locator carrying the original token hash and coordinator placement. An acquire,
release, or release-before-acquire retry uses that same journal even after a cell
move. **Operations snapshots must exclude `git_barrier_routes`** as control-plane
state, alongside `account_authority_*` and `resource_locators`. Finalized Git
receipts copied with repository metadata remain readable after a move without
restarting a publisher. A move's exact fenced operation may restore only into
its declared staged destination before cutover; ordinary writes remain gated
by current placement.

### Identity and rules

The gateway calls core `authenticate`, `getRepository`, and `authorize` on
each public request. The journal stores the authenticated `Principal`
(including credential ID), repository ID, routing epoch, policy revision,
operation ID, and exact old/new OIDs. Admission rehydrates current credential
and principal state and rechecks permissions immediately before granting a
publication permit. Commit author text is never used as an authenticated actor.

Rules are stored by identity. `GitRule` / `gitRuleSchema` in `@gitknot/git`
define the content/history portion consumed by native Git. Organization and
repository rules compose by intersection, with denials winning. Required
reviews, path owners, resolved threads, trusted verification results, and
allowed merge strategies are rechecked in the current-state publication gate;
native evidence contains every changed path and newly reachable commit.
Unknown rule fields fail closed. Identity/lifecycle mutations that promise a
completed revocation barrier must acquire the repository coordinator barrier
before committing the policy/lifecycle change and release it afterwards. An
in-flight publishing operation returns a conflict until its outcome is known.

### Operations and merge worker

Internal service requests use core
`signInternalRequest(request, key, scope)` /
`verifyInternalRequest(request, key, scope)`. Public actor headers are ignored.
Use the exported `gitServiceRequest` / `runGitOperation` helpers; the scope is
`git-service`. Internal request paths start with `/internal/git/`.

- `POST /internal/git/repositories/:repo_id/provision`: `{actor,operation_id}`;
  validate the durable lifecycle operation, create opaque Artifacts storage,
  revoke the initial implicitly-write token, and return storage readiness.
- `POST /internal/git/repositories/:repo_id/mutate`: run a typed `GitMutation`
  through the same gate as HTTPS push. The actor and operation ID are required.
  Kinds cover ref updates, browser edits, private HTTPS import, fork,
  merge-candidate construction/publication, restack, and protected review retention.
- `POST /internal/git/repositories/:repo_id/export`: stream a complete native
  Git bundle; collaboration metadata and LFS manifests are exported separately
  by the operations worker. No provider credential appears in the bundle.
- `GET /internal/git/repositories/:repo_id/operations/:operation_id`: inspect
  durable publication state, evidence, and verified result.
- `POST /internal/git/repositories/:repo_id/reconcile`: inspect canonical refs
  and the transaction marker, then finalize the journal/outbox if provable.
- `POST /internal/git/repositories/:repo_id/barrier` and `DELETE` on that path:
  acquire/release a token-bound lifecycle barrier. A timeout never clears a
  publishing fence.
- `POST /internal/git/repositories/:repo_id/move-publication`:
  `{operation_id,side:'source'|'target',action:'read'|'settle'}` queries the original
  coordinator using the identity-primary move placement, including after staged
  metadata disappears. `settle` requires the recorded rollback or source-cleanup
  decision, permanently closes the namespace to delayed publishers, and reconciles
  the actual native outcome. An absent operation without that closure is not a
  terminal receipt. Billing consumes the positive terminal fence before deleting
  physical storage; source-barrier release never interprets a 404 as success.

The Billing-owned `PlacementGitBackend` cleanup interface is:

```ts
reconcilePublisher(
  placement: StoragePlacement,
  side: 'source' | 'target',
): Promise<PlacementPublicationFence>;
```

`workers/git/src/storage-placement.ts` supplies this callback through
`reconcilePlacementPublisher` in `workers/git/src/move-publication.ts`. The receipt
contains `{version:1,operation_id,repo_id,storage_name,placement_fence,side,
source_epoch,target_epoch,state,finalized:true,writer_fenced:true}`; `state` is
`not_started`, `committed`, or `rejected`. It is returned only after the original
DO has durably closed that writer and proven its terminal outcome. Billing records
the receipt before scratch, namespace, or staged-metadata deletion. `verify` also
receives the explicit physical `side`, so same-cell/different-shard restore does
not confuse source and target metadata. The signed transport is
`POST /internal/git/storage-placement` in scope `billing.git-placement`, with
`{operation_id,side,action:'reconcile'|'cleanup'|'verify'}`. The direct diagnostic
query above returns `terminal:false` for unclosed absence and uncertain publishers.

Private imports accept an HTTPS source URL and an internal, transient source
authorization header. Public APIs accept a secret reference; the operations
worker resolves it through the secrets broker immediately before native work.
Never persist that plaintext in operation JSON, workflow checkpoints, or logs.
Forks require current read access to the source and write access to the target;
restricted-source visibility/access boundaries must also be retained by the
catalog. Native imports/forks validate every imported ref/object before target
publication. GitKnot's own transaction refs are excluded from fork/export.

Merge candidates are retained under access-controlled internal refs in Artifacts
before verification. Ordinary Git reads and object browsing hide these refs and
reject hashes that are not reachable from visible refs. Candidate checkout
requires the candidate-scoped route and current access to both repositories.
Candidate metadata binds repository, source repository, source head, target
base/ref, strategy, candidate OID, and policy revision. The merge worker supplies
`candidate_id` to publication; it cannot assert that checks passed. The gate
reads current trusted results/reviews itself. Changing head/base/policy
invalidates eligibility. Releasing compute while CI/reviews wait is mandatory.

### Fence and recovery semantics

Native `pre-receive` validates quarantine objects and the complete graph. Native
`proc-receive` owns canonical publication and never falls through to local ref
updates. Each push uses `--atomic`, an exact
`--force-with-lease=<full-ref>:<expected-oid>` for **every** ref, and an additional
operation-specific transaction ref with an expected-absent lease. No `--force`,
implicit lease, or non-atomic fallback is permitted. Success requires native
Git report-status, read-back of canonical refs/marker, and durable finalization.

The marker is part of the same atomic transaction and commits the operation's
identity and exact update manifest. It allows recovery after upstream acceptance
but before the local success receipt. If the marker is absent and an old
publisher's outcome is unknown, writes remain fenced even if its HTTP request,
container, token, or local deadline expired. Merely observing old refs does not
prove failure. Alarms reconcile; they never expire that fence. Replays cannot
republish after a marker exists because its lease requires absence.

The trusted publisher also runs a pre-push hook that verifies the complete
advertised old/new command set. Git normally omits up-to-date refs; that omission
must not evade an exact-old precondition. A porcelain `remote failure` (including
missing report-status) is uncertain, never a definitive rejection. Only explicit
server rejections, an unstarted publisher, or a verified atomic marker resolve a
publication fence.

Read **and untrusted receive** sessions use freshly packed, authorized-object-only
stores, with no alternates or cross-store delta reuse. Hiding ref advertisements
alone does not enforce confidentiality in Git v2. This also prevents a writer from
borrowing a hidden private candidate as an unprovided parent/object in a push.
Only safe native API constructors and an authorized merge context receive the
full canonical staging graph. Internal billing baselines contain object metadata,
never inaccessible object bodies. Ref/path names must be valid UTF-8; binary file
contents retain their original Git object IDs.

Development infrastructure selects `GIT_STORAGE_MODE=local` together with
`ENVIRONMENT=development`; the local authority is the signed
`infra/local/git-store.ts` / native filesystem service. Production and staging
cannot select that adapter. `GIT_NATIVE_IMAGE` must identify an immutable image
digest before production write capabilities can be attested.

Maintenance barriers require both `operation_id` and the exact token. Repeated
releases return the released state, including release-before-acquire. A released
operation cannot reacquire its fence, even under a fresh HTTP signature. Compact
tombstones persist for the coordinator lifetime (at least the 31-day documented
replay window); issuance deadlines only reject delayed *new acquisitions*. They
never expire an active maintenance barrier or an uncertain Git publisher. The
gateway preserves the original signed issuance time across internal forwarding.

REST ref transactions accept at most 16 updates so every ref retains its own
core request-authorization scope. Smart HTTPS uses the separately configurable
native ref-update limit. Public mutation routes use core external idempotency:
`git_api_commands` persists the actor and exact command under the stable request
operation ID before native submission, and recovery interrogates/resubmits that
same command against the actual publication journal.

Protected review/candidate retention updates its own Git journals, retained-ref
records, billing receipts, and internal events without changing the public
repository revision or `updated_at`. This keeps the repository snapshot captured
by PR creation or patch update valid for its own hidden retention work. Public
ref publication still advances the catalog revision. Core and collaboration
continue guarding the original repository/policy/placement snapshot; concurrent
public ref updates still reject that snapshot.

Collaboration `kind:'patch'` inspection accepts top-level `retain:false` for a
complete, read-only native patch inspection. Both repository ACLs are checked
before a helper is allocated. Omitted/true retention uses the durable protected
review-ref path and requires `pull_requests.write`.

An accepted merge queue's candidate can use fully scoped `pull_requests.merge`.
The queue, current patch/head/target/strategy/policy, queue order, parent operation,
native checkpoint ID, and original credential snapshot must all agree. Admission
checks every recorded old/new path; validation and the final permit reauthorize
the actual native ref/path evidence and recheck the saved queue identity.
Cancellation, supersession, changed credentials, or an unrelated operation ID
cannot inherit that authority. Ordinary candidate APIs require
`pull_requests.write`; final branch publication retains its native rules,
exact-old lease, and collaboration eligibility checks.

LFS pointer recognition follows the bounded reference decoder, including CRLF,
the legacy `hawser` and `git-media` version strings, blank lines and surrounding
Go-compatible whitespace. Every accepted pointer contributes its SHA-256 and
decoded size to native ownership and quota validation. Unsupported pointer-like
encodings are rejected. The parser never executes LFS filters or extensions.
See [the reference decoder](https://github.com/git-lfs/git-lfs/blob/main/lfs/pointer.go)
and [pointer specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md).

Signing-trust creation and revocation take `withRepositoryBarrier` around the
guarded metadata mutation. An already-permitted publisher must finish or be
reconciled before trust revocation can succeed; a returned revocation receipt
cannot race a still-authorized old publisher.

Browser file deletion uses NUL-delimited `update-index --index-info` mode-zero
entries in the bare producer. It removes only the validated literal path and
does not require a checked-out worktree; see
[Git's index-only protocol](https://git-scm.com/docs/git-update-index#_using_index_info).

Unadmitted LFS cleanup first fences the primary manifest and protocol row as
`deleting`, then uses billing `cancelStandaloneStorageIntent`. Its permanent
cancellation covers lost admission replies without requesting new budget. After
the exact cancellation receipt and physical absence are verified, manifest
deletion, upload expiration, and repository quota release commit atomically.
Sweep failures are isolated per upload so one unavailable cancellation does not
block unrelated expired uploads. Unknown in-flight writers retain their fences.

Private scheduled backup/move exports accept the recorded operation and full
retention flag, with `barrier_token` supplied or derived from the lifecycle's
fixed token convention. `requireMaintenanceAuthority` validates the durable
`operations_maintenance_intents` record, current system authority, owner and
placement. The coordinator's `/barrier/check` independently proves the exact
operation/token is still held with no active publisher. A caller's `maintenance`
flag grants nothing. The export includes protected review/candidate refs; archive
metadata and per-ref audience dependencies remain mandatory for public downloads.

Credentialless maintenance restore is restricted to a registered `repository.move`
request. `POST /internal/git/repositories/:repo_id/move-restore-authority` accepts
`{operation_id,archive_id}` and resolves the live source placement. It verifies
the maintenance intent, immutable move request, source/destination epochs, final
snapshot, source manifest checksum, exact Git inventory, and source barrier.
The destination and publication gate independently reread that authority; copied
maintenance rows and caller flags cannot grant it. Attribution uses the existing
`system:operations` service principal with no credential or ordinary capabilities.

The journal pins this proof in `context_json.maintenance`. Native restore still
checks the complete bundle, exact refs, LFS ownership, fresh target store, and
atomic publication leases. A verified move uses a graph-copy policy envelope;
existing push-only rules do not rewrite the already-retained source graph.
Its storage receipt leaves catalog revision and storage-name cutover to Ops.
The source barrier cannot release while a remote restore publication is pending
or uncertain. Canonical reconciliation can finalize an accepted copy without
obtaining a new maintenance grant or inventing a user credential.

Credentialed moves keep their original user/service principal, credential ID,
and permission ceilings. `context_json.move` pins the exact move-control and funded
placement identities, both physical epochs and metadata fences, original operation
and repository snapshots, verified archive digest, and complete restore manifest.
Validation and permit issuance recheck this proof. Only that verified physical move
leaves the staged catalog revision and `updated_at` unchanged for Ops' immutable
snapshot comparison and cutover; ordinary restore and public-ref publication retain
their existing revision semantics. Audit attribution remains the real actor.

The funded restore scratch object has one immutable writer/key/checksum generation.
A lost provider-create or native-publication acknowledgment retains that generation
and its financial hold. Retry reads operation-bound creation evidence and the original
scratch instead of uploading or provisioning a second copy. Existence alone never
promotes a pending creation into owned storage. Terminal journal finalization
settles canonical storage and cleans the original scratch; otherwise cleanup belongs
to a fenced rollback. A never-permitted publisher can be closed atomically, while a
possibly permitted writer retains both fences until its canonical outcome is proven.
Namespace identities use `placementStorageName(repo_id,operation_id)`, preserving the
complete case-sensitive IDs in a SHA-256 digest. A move requires its exclusive,
previously-absent create grant and a create-only provider request.

`beginPlacementGitProvision` durably allocates one unpredictable, operation/target-
bound `creation_marker`. `placementGitProvisionMarker` reads that same grant;
`confirmPlacementGitProvision(env, operation_id, storage_name, proof)` consumes
`PlacementGitCreationProof`, never an existence callback. Its exact shape is
`{version:1,provider:'local'|'artifacts',storage_name,provider_id,marker}`. Both the
marker and the first confirmed provider identity are frozen by Billing.
`PlacementGitBackend.observeCreation(placement)` returns that actual evidence or
`null`; missing, mismatched, or changed evidence leaves the original creation
unknown, funded, and fenced through retries and attempted rollback.

The adapters accept
`provision(name, defaultBranch, {create_only:true, ownership_marker})`. Artifacts
receives the reserved marker as `description` **in the create request**. Recovery
uses fresh `get(name).info()` / REST metadata to read the actual name, description,
and provider repository ID. It never writes a marker into an existing repository
or infers one from its URL. These fields are documented in the
[Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
and [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/); installed
Workers types expose the same creation/metadata fields. Provider atomic create-plus-
metadata and duplicate-name behavior remain deployment acceptance requirements.
No provider account calls establish those guarantees in this local verification.

`LocalGitStore` uses the same `provisionFilesystemRepository` implementation in the
filesystem service and native integration fixture. Atomic `mkdir` claims the
namespace before `git init`. After successful initialization, only that creator
writes an exclusive `gitknot-creation.json` containing the original marker and a
new provider identity; the file and directory entries are fsynced before positive
acknowledgment. Fresh reads return the persisted receipt, allowing an actual lost
success acknowledgment to recover. Existing entries receive the exact
`409 storage_namespace_exists` / `not_started` response without changing their
ownership record. Omitted/false `create_only` retains ordinary idempotent provision.
The gateway records that exact positive refusal through Billing's
`recordPlacementGitProvisionNotStarted(env, operation_id, storage_name)` before
returning it. Replays cannot promote a refused create into owned storage, and
rollback treats the foreign namespace as unallocated while settling this move's
actual scratch usage. The documented Artifacts `ALREADY_EXISTS` / `10201` error
uses that same explicit-rejection path. If the rejection response is lost, no
not-started outcome is invented: a foreign namespace's missing/different creation
marker keeps the original scratch, reservations, and source/destination fences.
Timeouts and lost acknowledgments never use the explicit-rejection path.

Ops archive-part authorization for a staged destination must consume the live
source move authority rather than call its source-epoch intent validator against
the destination's copied repository row at `epoch+1`. Maintenance movement
preserves owner, visibility, fork audience, policy revision, and default branch.
Restoring an archive into changed ownership remains on the current user-credential
and archive-audience path.

Purge retention matches Ops' external-reference checks: same-repository candidate
refs are part of the storage being purged, while active foreign candidate/patch
history, live forks, and explicit retention pins still block physical deletion.

Hook executables are located through trusted filesystem paths by
`services/git/src/hook-path.ts`. Source/Docker layouts and the Node entrypoint or
parent bundle directory are supported; `GITKNOT_NATIVE_HOOK_ENTRY` can explicitly
name an absolute installed hook artifact. Vite must emit `hooks.ts`, `hooks.mjs`,
or `hooks.js` alongside the native entrypoint. Static asset-URL expressions are
not used for executable hooks. The infrastructure native builder emits
`native.mjs` and `hooks.ts`; `bundled-smoke.mjs` verifies actual publication through
those artifacts. The full web E2E status is recorded separately below.

Review retention is canonical: `git_review_snapshots` binds evidence identity,
source repository, exact base/head/merge-base and the completed publication.
Protected refs are `refs/gitknot/reviews/<evidence_id>/{base,head,merge-base}`.
Historical diff requests must present the real `(repo_id,pull_id,patch_id)` rows;
the gateway verifies their evidence associations and both source audiences before
constructing a restricted read view. Archive manifests/audience dependencies must
include `git_review_snapshots.source_repo_id` as well as candidate sources when
their retained refs are exported. Ordinary bundle exports contain customer refs
only. Foreign provider refs are preserved as data; native processing always
disables replacement-object interpretation and repository scripts/hooks.

Full retention exports include every candidate with a retained OID, including
obsolete verification candidates; a rejected merge does not erase its candidate.
The ordinary bundle route excludes all protected refs. Full export authorization
checks every retained source, and the archive owner must persist that exact
audience dependency set through download and restore. `git_review_snapshots`
belongs in portable collaboration metadata alongside `git_candidates`.
Internal-only candidate/review retention emits a non-tenant-scoped internal
completion event without private refs, source identities, or actor details;
the scoped Git journal/audit retains full provenance. It does not emit a customer
push event. Collaboration emits its audience-authorized PR/candidate events after
the corresponding metadata transaction.

The hosted Worker also exports `ContainerProxy` for mandatory HTTPS egress
interception. Its helper profile is the deployed `standard-2` (1 vCPU, 6 GiB,
12 GB); 330 seconds are reserved with a 300-second independent process deadline
and teardown headroom. `GIT_HELPER_EGRESS_BYTES` defaults to 4 GiB and
`GIT_HELPER_OPERATIONS` to 1,024 initiating calls per episode. The profile's
operating-cost quote must finance those declared ceilings, not only CPU time.
`GIT_SIGNING_PRIVATE_KEY`, when bound to the trusted Git Worker, supplies an
OpenSSH platform commit-signing key. It is written only to the helper's private
ephemeral key directory and removed from its environment. Repository owners
must explicitly trust the corresponding public key for signature-required web
edits/merge construction. It is never a customer/job credential.

## Provider interfaces and rollout acceptance

### Local verification status — 5 October 2026

- `npx vitest run tests/high-level/git-native.test.ts tests/high-level/git-lfs.test.ts tests/high-level/git-budget.test.ts tests/high-level/events-movement.test.ts`:
  **39 passed across 4 files**, **220.07 seconds**, creation-proof closure
  run at **12:36:13**. These exercise actual stock Git smart HTTPS, shallow/deepen
  fetch, notes, quarantine/secret and surplus-object rejection, signatures,
  ref/path/size/ancestry restrictions, atomic publication, exact-old races,
  durable receipt-loss recovery, barrier ordering/tombstones, protected historical
  refs, verbatim fingerprints, restacks, private HTTPS imports, checksummed
  restoration, cumulative scans, core external idempotency and LFS billing.
  The added journeys exercise read-only cross-repository patch inspection,
  merge-only queue construction/cancellation, and current-placement routing
  across two real SQLite cells and separate native stores. Stock Git clones the
  moved store, sends a 6 MiB payload through a body-free handoff to the real
  destination size-rule gate, and loses access when its primary credential is
  revoked despite an active copied credential. Replay and header tampering are
  rejected; maintenance release still reaches its original coordinator.
  The final regression pass covers CRLF/legacy LFS pointer size and ownership,
  signing-key revocation paused behind a permitted publisher, unadmitted LFS
  cancellation with an independently failing cleanup, and actual protected-ref
  bundles from a registered scheduled maintenance operation.
- Maintenance move/purge coverage uses the
  real durable Ops request creator, two SQLite placements, native Git, and the
  billing controllers. It rejects changed owner/archive/authority, preserves the
  source barrier through a lost canonical result and withdrawn maintenance grant,
  reconciles the actual marker, and leaves catalog cutover to Ops. Purge permits
  self-owned retained candidates while active foreign candidates and pull patches
  continue to pin storage.
- Placement-safety cases cover a real provider create whose acknowledgment is
  lost, exactly one original scratch upload/provision, a credentialed move into a
  non-default metadata shard in another cell, unchanged frozen source snapshots
  and counters, and audit attribution to the original credential. A delayed,
  already-permitted native publisher blocks rollback until its actual atomic
  acceptance settles. Removing staged metadata does not turn that publisher into
  a successful 404. The shared real filesystem provisioner also rejects a competing
  creator after the absence check; retries and rollback leave its foreign namespace
  intact. A provably unstarted move cleans only its funded scratch under rollback.
- The creation-proof closure preserves the prior 37-test gate's assertions and adds a lost
  **actual 409 rejection** after a competing filesystem creator installs its own
  durable marker and real Git graph. Retry and repeated abort leave its refs,
  content, provider identity, original scratch/create counts, financial reservations,
  and both metadata fences intact. Source-barrier release also rejects unfinished
  physical rollback. The lost-success case independently reads the creator's
  fsynced provider receipt before recovery and verifies that Billing freezes the
  same marker/provider ID through the later lost caller reply and completed move.
- The PR regression uses the public collaboration and Git APIs, actual gateway,
  coordinator, native hooks, and billing controllers. It verifies PR create/replay,
  deletion diffs, patch update, and candidate retention without a catalog bump.
  A real interleaved public ref publication still returns 412 for the old PR
  snapshot. No inspection adapter fabricates native success or adjusts a guard.
- `tests/high-level/git-budget.test.ts`: **2 passed** against the production
  billing account/capacity controller and actual SQLite schema. Lost reservation
  acknowledgments retain capacity; provably unused expiry settles zero usage;
  uncertain startup requires destruction; late stream completion cannot change a
  frozen settlement after its acknowledgment was lost. Provider teardown is an
  explicit test boundary, not a claim about managed Containers.
- Docker Linux/amd64 image builds with Node **24.18.0** and checksum-pinned Git
  **2.54.0**. `services/git/scripts/local-smoke.mjs` performs and independently
  reads back a real canonical publication inside that image.
- `node --import tsx services/git/scripts/bundled-smoke.mjs` builds through the
  actual `infra/native-build.ts` pipeline, starts the emitted native/hook artifacts,
  and verifies an actual canonical publication. Executable hooks are filesystem
  paths, never Vite `data:video/mp2t` assets.
- The root TypeScript check for this pass reports three outstanding co-owner
  diagnostics in `infra/local/capacity.ts` and `tests/high-level/collaboration.test.ts`;
  no Git or Billing diagnostics. Their owners have the exact errors for the parent
  integration gate.
- Full web E2E now starts the actual isolated workerd stack and completes signup,
  provisioning, stock Git push, canonical storage settlement, and the first browser
  journey. `.gitknot/e2e/run-1791191263811-11bcf4e2/` records **1/3 passed**,
  including successful PR creation, real deletion-diff rendering, an old-side
  review thread, viewer download, and token revocation in the second journey.
  Its later secret creation failed with `vault_write_fenced` (the fresh vault key
  registry was empty); workflow validation returned `409 execution_conflict` while
  backup metadata fences remained held.
  The subsequent `.gitknot/e2e/run-1791192194453-6406c093/` run passes **2/3**,
  including the complete workflow/preview/cancellation/billing journey after the
  local vault-bootstrap wiring landed. Its PR request encountered a transient
  backup metadata fence: captured and actual repository revision were both 5,
  policy revision 3, and routing epoch 1. Retention was committed/finalized without
  changing the catalog; the backup fence released roughly 1.3 seconds after the
   rejected PR insert. The later parent run
   `.gitknot/e2e/run-1791195006954-03a96bc8/` records **3/3 passed, zero retries**
   after the exact metadata-fence deferral fix. That browser result predates this
   final placement-safety pass; the parent owns the subsequent full browser gate.
- All six Git/helper billing exports are linked through their actual exported
  types. The real-stack push's `git_publications.context_json.storage_admission`
  records its canonical reservation and `settled:true`. LFS continues to use the
  standalone account/slice storage controllers.

The local filesystem authority and local R2/D1 adapters are explicitly selected
test/development resources. They are not evidence that Artifacts atomicity,
managed Container egress interception, lifecycle timing, or account billing have
passed real-provider rollout tests. The operator-run
`services/git/src/probe-artifacts.ts` targets an existing isolated repository;
it is not run automatically and no Cloudflare resources were provisioned/deployed.

### Billing adapter coordination (5 October)

LFS uses the real `reserveStandaloneStorage`, `commitStorageObject`,
and verified `deleteStorageObject` adapter. LFS keys are account/repository scoped;
the protocol upload row and `object_manifests` retain the reservation, fence,
upload generation, and immutable SHA-256 association. Local repository quotas
are an additional guard; account-wide quota/budget authority is billing's account
coordinator.

Two separate billing primitives cover the Git gateway's production admission:
essential helper allocation and canonical Artifacts retention. The implemented
contracts are:

```ts
reserveEssentialService(env, {
  service: 'git-helper', allocation_id: string, profile: string,
  maximum_duration_ms: number, maximum_egress_bytes: string,
}): Promise<{ reservation_id: string; fence: string; maximum_duration_ms: number }>;
startEssentialService(env, { service: 'git-helper', allocation_id: string,
  reservation_id: string, fence: string }): Promise<void>;
settleEssentialService(env, { service: 'git-helper', allocation_id: string,
  reservation_id: string, fence: string, event_id: string, duration_ms: number,
  egress_bytes: string,
  termination_proof: { kind: 'container_destroyed' | 'never_allocated',
    receipt_id: string, verified_at: string } }): Promise<void>;

reserveCanonicalGitStorage(env, {
  account_id: string, repo_id: string, actor_id: string, operation_id: string,
  storage_name: string, routing_epoch: number,
  maximum_growth_bytes: string, retention_until: null,
}): Promise<{ reservation_id: string; fence: string }>;
commitCanonicalGitStorage(env, { account_id: string, repo_id: string,
  operation_id: string, reservation_id: string, fence: string,
  reachable_bytes: string, new_object_bytes: string, object_count: string,
  evidence_digest: string, marker_oid: string, verified_at: string }): Promise<void>;
abortCanonicalGitStorage(env, { account_id: string, repo_id: string,
  operation_id: string, reservation_id?: string, fence?: string,
  rejection_evidence_id: string }): Promise<void>;
```

Essential-service admission must use the preallocated **essential platform**
budget/capacity slice and immutable trusted-helper profile pricing. It must remain
independent of customer discretionary CI stops so reads/export/reconciliation
remain possible. Allocation IDs are container-DO ID plus a durable generation;
the allocation grant precedes startup. Holds survive uncertain startup/teardown;
settlement follows a verified `destroy()`/stopped-state receipt. `duration_ms` is
controller-observed wall time from allocation through teardown, not claimed CPU
usage or a fabricated provider invoice quantity. A conservative full-profile
operating-cost rate can bound that lifetime.

Helper admission persists its original profile and request bounds before calling
billing. A confirmed but unstarted episode is `admitted`; `starting` is persisted
before the financial start call. Only `admitted` can produce `never_allocated`.
Expired unused admission is reconciled and settled before the next generation.
Stopped episodes freeze their duration, egress bound, and teardown receipt so a
lost settlement acknowledgment can replay exactly.

The original helper operation-count ceiling is supplied to billing's caller-side
quote construction and persisted with the profile/version before capacity
admission; the capacity Worker reads that immutable quote instead of its own
operation-count default. Restore quotes recognize `git_publications.kind='restore'`
and the fresh digest-bound `gk_restore_<sha256>` store. Git also mirrors
`context_json.restore`/`placement`; the catalog's `storage_name` switches only
after verified publication. For a staged cell move, the exact fenced directory
operation selects its declared destination journal/repository at `epoch+1`
before cutover through billing's operation-aware metadata query.

Canonical storage evidence is computed by native Git from the complete ref graph
and raw object sizes, including retained refs. Internal transaction metadata is
measured separately in `marker_object_bytes` and is included in the conservative
growth exposure; it is excluded from customer logical reachable-byte totals. Billing
must define the customer meter as **logical reachable Git object byte-time**;
Artifacts does not document a physical-storage-byte field on `info()`. Native
evidence can also bound new-object growth relative to the refreshed canonical
graph. Retain conservative platform storage commitments for accepted growth until
provider reconciliation or verified repository purge proves physical release;
ref deletion/GC assumptions cannot release an uncertain provider cost hold.
Artifacts bills daily storage peaks averaged over 30 days, so operating-cost
accounting must fund the current daily peak even if a repository is deleted
within that day; do not reuse the R2 byte-time rate for that provider exposure.
Containers charge network egress. The helper reserves an explicit per-allocation
egress ceiling and consumes durable byte credits before forwarding outbound
request bodies or native response bodies. Protocol-overhead allowances are
identified as conservative operating-cost bounds, not provider measurements.
Account/repository admission must bound accumulated retained-growth exposure,
not permit repeated ref deletion to evade storage quotas. No physical Artifacts
usage is invented from compressed transfer or logical byte counts. The billing
adapter must verify the durable publication/marker receipt before commit and a
definitive rejected journal outcome before abort; uncertain outcomes retain holds.
Abort must also tombstone an operation whose reservation reply was lost (optional
reservation identity), so a delayed admission cannot revive that rejected intent.
The durable Git journal records the admission intent before calling billing and
keeps finalization/fencing pending until financial commit/abort is confirmed.

Research: 4 October 2026. The Artifacts binding is the documented Oct 1 surface:
`get(name)` returns a disposable repository capability; `info()` returns
metadata; `createToken("read"|"write", ttl)` returns `{plaintext, expiresAt}`.
Scopes are always explicit. The initial token returned by `create`/`fork` is
revoked. REST uses `/client/v4/accounts/:account/artifacts/namespaces/:namespace`
and the v4 envelope; token creation is `POST /tokens` with `{repo,scope,ttl}`.
Use the exact returned HTTPS remote, validated against the configured account.
Binding `log()` is first-parent only and is not a policy/ancestry primitive.

Production writes require a persisted capabilities attestation for the deployed
Artifacts namespace and native image. The rollout probe must prove advertised
atomic support, exact stale-old rejection, a failed multi-ref transaction
changing no refs, concurrent writers, recovery after acceptance, and configured
large-pack limits. Reads can operate before write admission is enabled. Local
native protocol tests use an explicitly selected development/test filesystem
authority. Those tests do not attest Artifacts behavior. No cloud resources are
created or deployed by the test suite.

Official references:

- [Artifacts binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- [Artifacts REST](https://developers.cloudflare.com/artifacts/api/rest-api/)
- [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- [Git quarantine](https://git-scm.com/docs/git-receive-pack#_quarantine_environment)
- [Git receive hooks](https://git-scm.com/docs/githooks#proc-receive)
- [Git conditional and atomic push](https://git-scm.com/docs/git-push)
- [Containers class](https://developers.cloudflare.com/containers/api/container-class/)
- [LFS batch specification](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
