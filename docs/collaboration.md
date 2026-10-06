# Collaboration backend

`registerCollaborationRoutes(app)` is exported from
`apps/api/src/modules/collaboration.ts`. Migrations `020`–`026` and
`099_collaboration_global_reads.sql` belong to this
module. Fields are snake_case; timestamps are UTC; source documents are canonical
Markdown with immutable history. Mutable resources use strong revision ETags and
`If-Match`. Route registration supplies the shared OpenAPI contract.

## Authorities and APIs

`collaboration_items` holds the current issue/PR/discussion/task document, number,
author, state, revision, document revision, lock and tombstone. Typed details join
through `(repo_id,id)` in `issues`, `pull_requests`, `discussions` and `tasks`.
`collaboration_document_versions` and `collaboration_history` are immutable;
comments and attachments retain their subject/repository association. Core
`mutate` commits conditional changes, audit, outbox and required effects together.

| Surface | Behavior |
| --- | --- |
| `/v1/repos/:repoId/issues` | Templates, typed statuses, labels, assignments, milestones, priorities, dependencies, duplicates and linked changes |
| `/v1/repos/:repoId/pulls` | Drafts, native patch versions/diffs, reviews, requested reviewers, anchored threads, suggestions, dependencies, restacking and merge queue |
| `/v1/repos/:repoId/discussions` | Categories, threaded responses, accepted answers, moderation, pinning and context-preserving conversion to an issue |
| `/v1/repos/:repoId/tasks` | Accountability, contributors, advisory claims, heartbeats, private workspaces, proposals/evidence and decisions |
| `/v1/repos/:repoId/{labels,milestones,drafts}` | Revisioned catalogs and owner-private Markdown drafts |
| Subject subresources | `/comments`, `/attachments`, `/versions`, `/history`, `/restore`, `/lock` |
| `/v1/users/:id/{followers,following,activity,preferences}` | Follows and privacy-filtered profile activity/preferences |
| `/v1/{feed,inbox,subscriptions,saved-filters}` | Chronological activity; independently actionable decisions; snooze, mute, digest and saved-view preferences |
| `/v1/search`, `/v1/search/code-scans` | Authorized metadata search with coverage, and complete revision-pinned asynchronous code scans |

Private drafts, inbox state, subscriptions and saved filters belong to their user.
Repository archives must not expose another user's private rows as public
collaboration content. Ordinary personal capabilities use the user's personal
account. OIDC/SAML sessions instead use their current organization context,
including linked users and managed users with no personal account. Core verifies
membership, MFA, credential scope/lifetime and SSO freshness; the requested
private-state capability also retains credential, provider and account-policy
ceilings. This grants no additional repository permissions. Every referenced
repository and private-fork/workspace subject is separately authorized:
`users.follow`, `users.profile.write`, `feed.read`, `inbox.read`, `inbox.write`,
`subscriptions.manage`, `saved_filters.manage`. Comments use
`pull_requests.review`/`tasks.write`; uploads use `attachments.write`.

## Global reads and user-state inventory

`/v1/search`, `/v1/feed`, `/v1/inbox` and profile activity read the current
repository authorities rather than treating `IDENTITY_DB` as a content shard.
The coordinator uses the operator's `CELL_BINDINGS_JSON` and each cell's
`SHARD_BINDINGS_JSON`, its default shard, and a same-cell root shard. Binding
object equality is never a placement signal. Explicit repository requests visit
only their current cells; global requests visit every configured cell/shard.

`POST /internal/collaboration/read` is registered by this module on the existing
API services. It requires a nonce-protected `collaboration.read` signature and a
strict versioned request. The fixed operations are window discovery, an exact
reference/subject read, inbox-ID location, label/milestone validation and coverage
inspection. Repository reads bind `(repo_id,cell_id,shard_id,epoch)` and recheck the
current placement around the read. No SQL, binding name or actor authority is
accepted from the request. No core private-RPC or runtime-binding change is
required.

Discovery uses a 51-key merge buffer: at most four local shard reads and eight
cell calls run concurrently. A public request consumes at most four 50-source
windows, ten seconds of scan work and eight MiB of searched canonical text.
Private responses are capped at four MiB. Responses distinguish complete,
partial and unknown source coverage. An unavailable cell cannot become an empty,
complete result. A partial/unknown page carries a resumable continuation; no
unconfirmed key range is skipped.

Search uses stable resource IDs; feed/inbox use `(created_at DESC,id DESC)`.
Encrypted, padded continuations bind the normalized query, original `as_of`,
credential audience and configured topology. Their scan anchor is global, so a
repository move between existing placements preserves continuation without
repeating or losing the retained source rows. Copied old rows are hints: each
reference is hydrated from its current epoch and reauthorized before returning.
A configured topology change invalidates the continuation explicitly.

One current-authority eligibility predicate runs before/after hydration and again
for the assembled page, including its lookahead. Global discovery excludes a
currently unlisted repository even when a retained source snapshot still marks
it public. Public-only feeds require current public visibility, including for an
owner who could otherwise read private content. Core resolves the current owner
and grants, and activity checks re-read current identity/profile privacy. The
hydrated source must also match the requested kind, state, actor and recipient.
Explicit repository/subject reads retain ordinary URL-scoped unlisted access;
discovery exclusions do not broaden into a repository access denial.

User and mention references are read from the identity authority. On a moved
repository, minimal disabled user rows provide FK material only. They carry no
credentials or grants and never decide whether an assignee is active. Mutations
capture the referenced user's applicable identity-account epoch before the final
primary read, and core fences that epoch in the repository transaction. Assignee
representations likewise hydrate current identity metadata instead of displaying
disabled move stubs.

Canonical title/Markdown matching remains available while an index is missing or
stale, with index coverage reported separately. Coverage counts and digests
include only authorized documents. Unavailable coverage has null counts and
`current:null`; a bounded prefix/continuation window is labelled as such, never
reported as an exhaustive zero-document repository. A repository is current only
after its source window, source watermark and corresponding index are verified.

Migration `099` preserves existing subscription/filter IDs and revisions while
copying identity-authority rows into the user-owned tables below. The old tables
are legacy data, not the new user-state write authority. New tables intentionally
use `repository_id` as an opaque locator rather than a repository-local FK or an
ownership column. They must stay on `IDENTITY_DB` through repository moves.

| Identity-owned table | User owner | Context | Referenced source |
| --- | --- | --- | --- |
| `collaboration_user_subscriptions` | `user_id` | `context_account_id` | `repository_id`, nullable `subject_id` |
| `collaboration_user_saved_filters` | `user_id` | `context_account_id` | nullable `repository_id`, `filter_json.repo_ids`, labels/milestone/user filters |
| `collaboration_user_inbox_state` | `user_id` | `context_account_id` | `repository_id`, `notification_id`, exact `source_event_id` |
| `collaboration_profile_preferences` | `user_id` | global user preferences | user identity |
| `user_follows` | `follower_id` | global user graph | `following_id` |

`collaborationUserStateInventory` exports this inventory. Context is a visibility
namespace, not a transfer of ownership to an organization. Account-export code
must read these rows on the identity authority, select the separately authorized
user owner/context, and reauthorize all referenced repositories/subjects. An
organization export must not absorb a linked user's personal-context state or
global private preferences merely because that person is a member. These rows
are not ordinary repository archive/move components.

Normal and organization-scoped subscriptions/views have separate context keys.
For a multi-organization federation credential, `account_id` selects one current
context; the default is the first authorized account in stable ID order. A linked
SSO session cannot retrieve the user's personal-context views or personal code.

Repository-local `collaboration_inbox` continues to commit atomically with source
actions. The identity-owned overlay records read/snooze/acknowledgment intent for
one source event. A new event resets that intent; resolved source actions cannot
be reopened by an old overlay. The public inbox revision combines source and
overlay revisions, while concurrent overlay edits use a guarded identity CAS.

Mail integration: `readInboxForDelivery` returns `source_revision` for the
repository witness and a `user_state` witness for the identity authority.
`inboxDeliveryUserStateGuards(identityDb,witness)` belongs in mail's final identity
release transaction. It fences the overlay, digest/privacy preference and exact
subscription set, so a late mute/snooze/change cannot reuse an earlier release.
The ordinary repository inbox guard uses `source_revision`, not the combined
public revision.

## Review and merge correctness

Public patch creation/update resolves the actual target and source refs. Supplied
OIDs are preconditions; a caller cannot select an intermediate ancestor to hide
changes. `getMergeEligibility(c,pullId,options)` recomputes the complete current
target-relative patch and checks it against the recorded version. A legacy or
outdated partial patch blocks merging until refreshed.

Review retention completes durably before a PR or new patch becomes usable.
Its hidden refs advance the native publication/snapshot journals rather than the
public repository catalog revision. The original repository, policy, credential
and document guards remain exact throughout the request. After retention,
collaboration resolves both public refs again and rejects source or target drift.
Concurrent user metadata/policy changes still abort the original guarded write.
Core idempotency retains the committed PR identity when the final HTTP response
is lost; retries reuse the content-addressed retained evidence and the same
committed PR rather than creating duplicates.

`common.commit` delegates to core `mutate`, whose `executeMutationBatch` handles
brief ordinary metadata-fence contention. Only the named ordinary-fence abort is
eligible for a bounded wait (2,500 ms by default, capped at 3,000 ms). After release,
the exact prepared D1 statements retry at most once with their original PR, patch, event,
audit and idempotency identities and all captured guards. Retention and public-ref
validation execute once. Owner-receipt failures remain immediate conflicts;
changed public revisions, policy, credentials, resource revisions or idempotency
generations cannot acquire a fresh grant through deferral.
An unreleased or replaced fence returns HTTP 423 `repository_metadata_busy` with
`Retry-After: 1`; an invalid owner receipt or changed original guard remains a
conflict rather than a renewed authorization.

Unmerged stack dependencies remain in review coverage. Rebase ancestry is
separate: `pull_dependencies.base_oid` tracks the linked parent's historical
head for restacking. Dependencies must merge before their dependents can merge;
restack publication is native Git with exact expected-old refs.

`pull_patches`/`pull_patch_files` retain immutable native evidence.
`pull_reviews`, `pull_review_files`, `pull_review_validity`, dismissals, threads
and requests preserve review history. Decisions use their atomically assigned
`submitted_revision`, then select the latest applicable decision per
reviewer/file. Reviewing beta does not supersede a prior alpha approval.
Unchanged file fingerprints preserve coverage; changed files invalidate it.

Fingerprints require `fingerprint_algorithm:'git-patch-id-verbatim-v1'` and native
`git patch-id --verbatim`. [Stable mode alone ignores all whitespace][patch-id],
so it is insufficient for approval preservation. Whitespace-only Python/YAML
changes must invalidate affected coverage.

Required reviewers cover the complete current change. Path owners accept
canonical `team_*` IDs and `team/`/`user/` aliases with current membership and
authorization from the identity authority, including when repository shards have
stale identity copies. Minimum reviews apply per changed file. Unresolved-thread and
author-approval policies are evaluated against current evidence.

Verification evaluates both flat requirements and bounded `all`/`any`
expressions, including producer lists, definition digests and trusted path
conditions. It reads execution-owned `workflow_verifications` joined to current
workflow versions, runs, jobs and attempts. Repository, actual candidate commit,
policy revision, workflow digest, plan digest, trusted producer, toolchain,
current attempt and authenticated completion must agree. A display name or
user-authored status cannot satisfy a check.

An exemption is distinct from a passing check. `not_applicable` is accepted only
when either the current trusted rule excludes the actual candidate paths, or a
validated server manifest proves a current policy-authorized path exemption.
The latter requires the current approved definition, candidate/PR/ref identity,
complete native candidate path coverage, no attempt, and a fresh compilation
under the current execution policy and toolchain catalog. A stored conclusion or
reason alone grants no exemption. Manual requests, trigger/ref mismatches,
missing results, cancelled runs, and stale or incomplete provenance stay blocking.
Latest runs are selected by their atomic enqueue order; an incomplete newer run
cannot fall back to an older passing or inapplicable result.

`all` permits independently exempt requirements. `any` requires a satisfied
**applicable** branch: an exempt leaf or entirely exempt nested `all` cannot
rescue a failed applicable alternative. An `any` whose alternatives are all
exempt remains blocking; no whole-expression exemption is implicit. Rule path
filters use an empty `include` list to mean all paths. Account rules are loaded
from the identity authority; repository rules come from the repository shard.

Eligibility independently inspects the retained candidate against its exact
target, including both old and new rename paths. Candidate paths outside the
reviewed change block merging. The durable `merge_candidate.created` event
carries this native-derived `changed_paths` inventory for the execution planner;
the eligibility gate rechecks it rather than trusting the event inventory alone.
Execution's trigger adapter must consume that inventory with the retained
candidate/PR/ref identity. An event without complete candidate paths cannot
establish a path exemption.

`pull_merge_queue` is the durable queue authority. The final Git gate imports
`getMergeEligibility` and rechecks immediately before publication. A PR is never
marked merged from an HTTP status or a locally constructed commit: finalization
requires the exact canonical native publication receipt.

## Native service contract

All calls use core internal signing, scope `git-service`, the bound `GIT_SERVICE`
and `/internal/git/repositories/:repoId/…`. No provider credentials enter public
responses. `collaboration/native.ts` exports the strict request/evidence schemas.

- `collaboration/inspect` receives `{actor,retain,inspection,candidate_id?}`. `patch`, `diff`,
  `resolve`, `suggestion` and `scan` use native full-graph/object processing.
- `retain:true` keeps review commits under durable protected refs. Historical
  diffs require their recorded `(repo_id,pull_id,patch_id)` association; a hash
  alone cannot read those refs.
- **`retain:false` is read-only patch verification.** The gateway authorizes
  both repositories and skips retention and its `pull_requests.write`
  requirement. Readers and ref/path-scoped merge-only
  credentials use this mode. Merge admission resolves the full ref/path scope
  before core authorization. Candidate creation for an admitted merge queue
  accepts that exact `pull_requests.merge` authority. `candidate_id` additionally
  authorizes the retained candidate and its source repository for candidate-path
  verification, including candidates not reachable from public branch refs.
- Suggestions return
  `{repo_id,head_oid,edit:{path,content_base64,mode}}` for the gated `edit` mutation.
- The gated `restack` mutation is
  `{kind:'restack',ref,expected_oid,old_base_oid,onto_oid,onto_repo_id,pull_request_id}`.
  Every verified source result creates a new patch and explicit review impact.
- Scan counters are cumulative. `matches` and `exclusions` are page entries.
  The final invariant is `scanned_files + excluded_files === total_files`.
  Pagination can split a large matching file without dropping results.

## Storage and recovery

Attachments use `object_manifests` with `kind=collaboration_attachment` and a
normalized association in `collaboration_attachments`. Keys are
`${account_id}/${repo_id}/attachments/${attachment_id}/${sha256}`. Register the
immutable object locator on the identity authority before admission. Public
ETags use the manifest revision; billing IDs/fences, keys and generation internals
are private.

The lifecycle is `reserving → pending → uploading → ready → deleting → deleted`.
Account-wide byte and monetary admission uses `reserveStandaloneStorage`; only
the repository byte cap is local. Persist the admission receipt before accepting
input. Claim one upload generation before buffering or R2 writes. Exactly one
conditional R2 write is issued per generation. Definitively incomplete input is
rejected before R2 and may retry as a new generation. Unknown acceptance stays
fenced; neither an absent object nor an elapsed deadline proves termination.

Completion requires positive R2 evidence matching repository, subject,
attachment, object, generation, bytes and SHA-256. `commitStorageObject` settles
account/platform storage before a fresh subject ACL check and guarded publication.
Deletion first fences the manifest, uses `deleteStorageObject` to verify physical
removal and financial release, then releases the local repository quota once.
Active deletion sagas use `retention_until=NULL` so a generic TTL reaper cannot
race an unmetered deletion.

Create/prepare/complete/delete declare core's **external idempotency strategy**.
`collaboration_attachment_sagas` binds the request, subject, object, principal and
generation before I/O. Recovery resumes that same binding; it cannot allocate a
replacement or complete an older request against a newer upload generation.

Parent soft deletion atomically enqueues `collaboration_attachment_cleanup`,
including in-flight uploads. Ready/unused objects are fenced and deleted. An
in-flight producer remains blocked until positive generation-bound evidence
exists; it can then be settled and fenced directly for deletion without making
the deleted subject readable. `sweepAttachmentStorage` retries cleanup.

Expired/abandoned `reserving` intents use billing's
`cancelStandaloneStorageIntent(env,{account_id,repo_id,object_id})`, backed by
`storage-cancel-intent`. Billing verifies the current primary fence and creates
an account/slice tombstone even when no reservation exists. No new budget is
needed. Collaboration checks the immutable receipt and R2 absence before local
quota release.

Generic object routes call `authorizeAttachmentObject(c,objectId,write)` before
metadata/download/delete. A repository-only ACL does not authorize a private
fork's conversation. Generic cleanup must preserve the same billing/fence rules.

## Background authority

`runCollaborationOperation(env,id)` and `sweepCollaboration(env)` are dispatcher
and scheduled entry points. Core `operations` is the public authority; the
module's context retains immutable input digest and original principal ceilings.

Migration `026` registers credentialless `svc_collaboration_maintenance`, backed
by internal `acc_collaboration_system` for real cross-D1 identity epochs. It has
no public credentials, memberships or repository grants. Bookkeeping resolves
the current repository placement, stops at move/fence barriers and uses guarded
CAS writes. A missing/disabled authority is an error, not a silently ignored race.

New Git work rehydrates the initiating principal and current credential. Internal
lease/outcome bookkeeping is independent of that credential: an already accepted
merge can be reconciled after revocation. Accepted source-change receipts remain
recorded while any required patch refresh awaits current authority. The same
principal can explicitly resume an unleased pending/waiting/failed operation
with a renewed credential. Retention lifecycle requests preserve the separate
`system:collaboration-retention` attribution (`account_id=NULL`) expected by
operations' validated maintenance path.

## Search and delivery

Use operations' `SEARCH_DB` schema; FTS virtual tables never enter authoritative
D1. Search authorizes source subjects and both PR repositories before matching
and public pagination. Lookahead contains only authorized matches. Authenticated,
encrypted `s1.` continuations bind the query and credential scope; private matches
cannot generate an empty continuation page or expose internal IDs.

Coverage counts only authorized documents. `source_revision` and
`indexed_revision` are viewer-scoped snapshot digests, not global counters
containing private-fork activity. Reauthorize hits before returning current text.
Code scans are owned by `principal_id`; nullable `user_id` is attribution only.
Scan execution checks current authorization, cancellation and exact coverage;
retained result pages are checksummed and reauthorized on every read.

`readInboxForDelivery(c,inboxId)` takes the recipient's current principal context
and checks subject/fork ACLs, unresolved source action, snooze, mute and digest.
Mail calls it immediately before delivery. Reading an event never completes its
assignment, review request or task.

## Verification

Final integration results are recorded in [verification.md](verification.md): **277 high-level checks passed**, one Windows-only acceptance was skipped, and all three expanded browser journeys passed. Global-read/SSO/discovery and mail-witness regressions are integrated. The following entries retain earlier scoped verification history; their former external blockers are resolved.

`npm exec -- vitest run tests/high-level/collaboration.test.ts`: **17 passing journeys**.
The original nine journeys plus eight regression journeys cover real-Git
intermediate-base and whitespace attacks, required owners/reviewers,
`all`/`any` checks, disjoint review scopes, private search pagination/coverage,
keyed storage recovery and parent deletion/expiry, personal/ref-scoped authority,
and credential renewal/revoked-credential reconciliation. Review revocation and
account-rule coverage also use a separate identity database with stale repository
copies. The applicability journey combines real Git candidate paths, production
workflow planning/manifest validation, durable run and failure transitions, and
the HTTP eligibility gate. It exercises incomplete coverage, trusted exemptions,
nested alternatives, current policy/toolchains, cancellation and missing triggers.
The composed PR journey uses the production API composition root, actual Git
gateway, repository coordinator and billing controllers, plus native sessions,
callbacks and stock Git pushes over HTTP. Its only Git storage substitute is an
explicit local bare-repository authority. It verifies retained base/head/merge-base
refs before PR publication, stable PR identity after a dropped final response,
and source, policy, repository-setting and concurrent document revision races.
It also captures the fully prepared PR batch behind a metadata fence, releases
the fence after 1.3 seconds, and checks statement identity and native-call counts
across exactly two attempts: the aborted batch and its sole retry. Core migration
`097_metadata_fence_wait.sql` supplies the named ordinary-fence abort and is
included by both the SQLite fixtures and fresh local E2E setup.
Storage journeys use
the production account/slice controllers with explicit local durable-storage,
SQLite and R2 adapters across isolated repository shards.

The global-read repro first demonstrated the missing remote search/feed/inbox
rows, false zero-document coverage, managed-user 404s and linked-SSO 403s. Its
regression now passes. A separate real Workerd journey uses three cells and
non-default shards, real SQL and current OIDC/SAML session grants, then completes
a production shard move with actual native Git verification. It checks global
continuation across the move, new post-move users/mentions, scoped subscriptions
and views, concurrent inbox updates, late mute witness rejection, unavailable-cell
coverage/recovery, unsigned private-RPC rejection and SSO membership revocation.
The same Workerd journey moves a public repository, changes the destination to
unlisted through its real catalog PATCH, and verifies that the retained public
snapshot leaks neither IDs nor snippets/coverage. It also changes visibility
between discovery and hydration, changes it after an earlier result hydrated,
and changes profile privacy before final page validation. Explicit unlisted
repository reads and existing owner/SSO grants remain exercised.
No browser stack or shared web build is involved in these checks.

The final combined command passes **18 tests**: all 17 collaboration journeys and
the existing mail-recovery journey:

```sh
npm exec -- vitest run tests/high-level/collaboration.test.ts \
  tests/high-level/events-recovery.test.ts \
  -t 'collaboration HTTP and durable workflows|keeps stable mail membership'
```

Native publication receipts use an explicit signed fixture; native inspection
regressions run real Git. Provider protocol acceptance belongs to the Git suite.
The two native gateway regressions for read-only cross-repository inspection and
scoped merge-queue candidate publication pass, as do all four compiler journeys.
The final `npm run typecheck` passes repository-wide.
No deployment or cloud provisioning is performed.

The October 5 unchanged PR assertions passed in the complete
**code and scoped settings** browser journey:

```sh
GITKNOT_LOCAL_STATE=.gitknot/e2e/collaboration-metadata-defer-20261005-final \
  npm run test:e2e -- --grep 'code and scoped settings'
```

Result: **1 passed**, including native file reads/downloads, PR creation,
deleted-file diff and old-side review-thread creation, viewer access/revocation,
and write-only secret rotation/revocation. The vault owner’s retained-tombstone
contract is checked by the updated vault assertions; the PR assertions are
unchanged. The fixture, passing journey receipt and HTML report are in
`.gitknot/e2e/collaboration-metadata-defer-20261005-final/`. The harness exited and
released ports 5173, 8787, 8788, 8790, 8791 and 8792.

An earlier October 5 independent browser run is retained under
`.gitknot/e2e/collaboration-pr-20261005/`. Sign-in and the real PR form reached
the backend; the create request returned HTTP 409 (`req_7bd4e978d9db443bb093361ec5941749`)
because automatic backup
`op_backup_861657aed8b1de9f65e6758b7e98e2bc3accdc2b36f6dcff` held the native
maintenance barrier while stalled in `verify-export-source`. A signed native
diagnostic confirmed `repository_fenced`, before any retention publication.
That earlier run recorded the operations-recovery blocker; it was not a passing
browser journey. Its screenshot and private HAR are `pr-retention-blocked.png` and
`pr-retention-browser.har` in that directory. The owned diagnostic harness was
stopped and its port lease released for execution E2E verification.

References: [D1 transactions][d1], [R2 checksums/conditional writes][r2],
[Hono Context][hono], [Zod validation][zod], [Git patch identities][patch-id].

[d1]: https://developers.cloudflare.com/d1/worker-api/d1-database/
[r2]: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
[hono]: https://hono.dev/docs/api/context
[zod]: https://zod.dev/api
[patch-id]: https://git-scm.com/docs/git-patch-id
