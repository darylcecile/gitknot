# Authoritative routing and identity fences

## Integration interfaces (routing owner)

The identity authority is `IDENTITY_DB ?? ROOT_DB ?? DB`. `IDENTITY_DB` must name the same primary identity database in every metadata cell. Whenever it is bound, **`IDENTITY_CELL_ID` and `IDENTITY_SHARD_ID` are required** and describe its configured physical D1 location. Metadata `DB` is described by `CELL_ID`/`SHARD_ID`; additional shard bindings name their configured physical shard. Binding aliases can be different JavaScript objects for the same physical database. Core never compares or introspects D1 objects to decide colocation.

Request storage ownership (`identity`, `repository`, or internal cell work) is recorded separately from its physical database location. Two logically different authorities can share one physical D1 and use the existing atomic fast path. A repository authorization scope does not change an identity-owned resource into repository storage. `database(c)` follows the explicitly selected request authority. Seeded identity rows in a repository shard are foreign-key material, never grant authority.

Use `identityAuthorityBindings(env)` before replacing `DB`/`SHARD_ID`; it preserves the identity binding and both location descriptors. The initial unbound `DB` remains the single-database fast path. Missing or partial explicit descriptors fail closed, including on other cells.

Core exports these interfaces through `@gitknot/core` (and the `authority`, `locators`, and `routing` subpaths):

```ts
identityBinding(env: Bindings): D1Database
identityDatabase(c: AppContext): D1DatabaseSession
identityDatabaseLocation(env: Bindings): DatabaseLocation
identityAuthorityBindings(env: Bindings): Required<Pick<Bindings, 'IDENTITY_DB' | 'IDENTITY_CELL_ID' | 'IDENTITY_SHARD_ID'>>
readRepositoryAuthority(c: AppContext, repoId: string): Promise<Repository | null>
resolveRepositoryPlacement(env: Bindings, repoId: string): Promise<RepositoryPlacement | null>
requestDatabaseBinding(c: AppContext): D1Database
requestDatabaseAuthority(c: AppContext): RequestDatabaseAuthority
requestDatabaseLocation(c: AppContext): DatabaseLocation
selectedRepositoryScope(c: AppContext): string | null
selectIdentityDatabase(c: AppContext): void
selectRepositoryDatabase(c: AppContext, placement: RepositoryPlacement): void
setRequestDatabase(c: AppContext, binding: D1Database, authority: RequestDatabaseAuthority): void

fenceAccountAuthority(c: AppContext, accountId: string, barrierId: string): Promise<AccountAuthorityVersion>
releaseAccountAuthority(env: Bindings, accountId: string, barrierId: string): Promise<void>
withAccountAuthorityBarrier<T>(c: AppContext, accountId: string, reason: string, action: () => Promise<T>): Promise<T>
recoverAccountAuthorityBarriers(env: Bindings, limit?: number): Promise<number>
registerRepositoryPlacement(env: Bindings, placement: {
  repo_id: string; account_id: string; cell_id: string; shard_id: string; epoch: number;
}): Promise<void>

registerResourceLocator(env: Bindings, locator: {
  resource_id: string; resource_type: GlobalResourceType; repo_id: string | null;
  authority?: 'identity' | 'repository';
}): Promise<void>
registerRepositoryResourceLocators(env: Bindings, db: Database, repoId: string): Promise<void>
routeResourceRequest(c: AppContext): Promise<Response | null>
handleRoutingRpc(request: Request, env: Bindings): Promise<Response | null>
```

### Identity and catalog wiring

- Use `identityDatabase(c)` for accounts, users, principals, credentials and ancestry, memberships, teams, roles/capabilities, grants, installations, account policy and federation. Account- and repository-scoped grants have this **same** write authority.
- Use `readRepositoryAuthority(c,id)` for policy repository metadata, the final catalog reread, private-fork ancestors, and cross-repository PR/source access. It resolves each repository independently without changing the request's metadata database. Owner, visibility, lifecycle, policy revision and routing epoch come from the current placement.
- After inserting the existing `account_policy_barriers` row on the identity primary, call `fenceAccountAuthority(c,accountId,id)` **before** changing access. Complete `releaseAccountAuthority(env,accountId,id)` before reporting success or removing the policy barrier. Both phases await every enrolled placement's acknowledgement. An uncertain phase stays fenced and is recovered by the explicit recovery helper.
- Wrap repository owner/visibility/fork-audience/deletion changes in `withAccountAuthorityBarrier` in addition to their native repository barrier. This advances the account epoch even when the account's grant revision did not change. It also fences requests in other repositories that depended on this repository's audience. Transfers must cover both affected accounts in stable ID order.
- Credential revocation/scope changes, user authentication-epoch/disable changes, and principal disable/expiry changes require the same barrier for their principal account (and human personal account, if different). Routed mutation authority includes every credential ancestor's account dependencies. Expiration is also checked against the database clock at the metadata commit.
- Shared `mutationStatements`/`mutate` guard the actual placement epoch, current account authority epochs, original credential authority, and all retained scopes. Primary-local writes retain their existing single-database guards. Do not add SQL predicates against copied identity rows on a metadata shard.

### Creator and movement wiring

- Register each globally addressable ID on the **identity primary** before its D1 create/intent can commit or be acknowledged. An orphan locator is safe; an acknowledged ID with an eventually delivered locator is not. Locators bind only immutable resource ID/type to repository ID; permission and ownership are always reread.
- `mutationStatements` registers a recognized primary event resource before its batch. Creators must explicitly register additional IDs (including pending run IDs and nested operation IDs) and background-created IDs. Types cover `operation`, `run`, `workflow_operation`, `webhook`, `delivery`, `archive`, `object`, `attempt`, `runner_pool`, `runner_enrollment`, and `runner`.
- A locator's immutable `authority` distinguishes storage from authorization scope. All current pool/enrollment/runner creators explicitly use `identity` even when `repo_id` restricts access; legacy lookups also default to `identity`. A repository scope on a primary-owned role/pool is not evidence of metadata placement. Run, attempt and workflow-operation creators use `repository`.
- Before a move's destination becomes writable, call `registerRepositoryPlacement` for its new epoch. Before cutover, while source writes are fenced, call `registerRepositoryResourceLocators` against the source so existing global resources remain reachable after source removal. Account enrollment is serialized with policy barriers; an in-flight registration cannot escape a revocation's placement set.
- Exclude `account_authority_*` and `resource_locators` from repository snapshots. These are identity/control-plane state. Destination local fences are installed by the authority protocol, never restored from source snapshots.

### Composition

Call `routeResourceRequest(c)` for `/v1/*` before route handlers, mutation authority capture, authorization callbacks and idempotency. It handles repository URLs and global resource URLs. Return its non-null response. Global retained source records are only legacy locator hints; the selected handler always rereads the current placement.

Expose `handleRoutingRpc(request,env)` only through the private API composition. Its fixed, authenticated protocol supports repository metadata reads and account fence installation. It validates method, body, scope, placement and monotonic epoch; it accepts neither SQL nor public actor headers. Cell and shard maps are bounded operator configuration.

Public cross-cell forwarding uses a separate routing-only envelope. Its purpose-separated MAC binds method, origin/path/query, authentication/CSRF/precondition headers, exact repository placement and epoch, hop count, nonce and a 60-second **admission** deadline. It never clones, hashes or buffers the public body. The destination still authenticates the actual credential and validates manifest size, checksums and streamed bytes. Replay is rejected on the destination D1. Only `/v1/*` and the exact hosted-attempt callback path accept this envelope; callback-specific signatures remain intact and independently verified. General private RPC retains its original content-bound signature.

Runner pool creation stays on the identity primary regardless of its optional repository permission scope. Enrollment collection routing reads only bounded JSON hints before admission: enrollment `pool_id`, and the enrollment ID embedded in `gkenr_enr_<32hex>_<random>`. Existing instance and enrollment collection lookups honor locator storage authority. A token's embedded ID never substitutes for hashing and authenticating the complete one-use token.

The request-recovery layer should obtain its D1 binding through `requestDatabaseBinding(c)` so its admission, receipts and resource effects stay on the same selected authority.
Use `selectedRepositoryScope(c)` for initial idempotency scope. Never infer it from D1 reference equality or from a policy's `repo_id`. Context clones pass `requestDatabaseAuthority(original)` as the third `setRequestDatabase` argument; identity and repository callers normally use the corresponding explicit selector instead.
Persist the initial repository/account scope alongside `policy_json` and the external `operation_id` when claiming an idempotency request. Pending repository requests must be included in the move's final snapshot, before any resource event has filled a receipt.

Lifecycle URL exceptions allow restore and transfer management to reach their existing authorization and state gates. Their metadata guard compares the exact lifecycle state captured by routing; it does not broadly permit writes to deleted or moving repositories.

The exact POST callbacks `/internal/hosted/attempts/:id/destroyed` and `/v1/attempts/:id/terminated` also pass lifecycle routing fences. They authorize an attempt cleanup capability and independently verified termination, not repository access or result publication. `repositoryCleanupRequest(request)` identifies only these two fixed paths so shared HTTP admission can leave their independent capability checks to the execution handler. Other attempt callbacks remain fenced. Hosted execution must be quiesced and destruction verified before metadata copy/cutover; a move does not relocate live VM/controller authority.

### Placement-local metadata fences

Native and directory barriers cannot fence a D1 transaction that was already prepared. Every shared `mutationStatements`/`mutate` batch with logical repository storage therefore also checks the durable, **local** `repository_metadata_fences` table in the same transaction as its effects. The check is independent of admission timing and repository revision: an ordinary writer requires no held fence for that repository. Identity-owned storage remains independent even when its authorization includes the repository.

Operations migration `093_metadata_fences.sql` installs `{repo_id,operation_id,routing_epoch,fence_id,state:'held'|'released',updated_at}` plus immutable acquisition receipts. The acquisition's opaque `fence_id` is retained through retries. Release retains a tombstone; delayed acquisition must not reopen the released operation identity. These control rows are excluded from repository snapshots/moves.

```ts
type RepositoryMetadataFence = {
  repo_id: string; operation_id: string; routing_epoch: number; fence_id: string;
};
inRepositoryMetadataFence<T>(c: AppContext, fence: RepositoryMetadataFence, action: () => Promise<T>): Promise<T>
repositoryMetadataFenceGuard(db: Database, repoId: string, guardId: string, owner?: RepositoryMetadataFence): D1PreparedStatement
```

Only trusted operation code installs `inRepositoryMetadataFence`; no actor, route, operation ID header, or request body establishes this context. An owner batch requires the exact still-held operation/epoch/acquisition tuple. It fails after release or replacement rather than falling back to an ordinary writer. Its original identity, account policy, routing epoch and revision guards continue to apply. Raw metadata adapters append `repositoryMetadataFenceGuard` to their own D1 transaction and remove its `mutation_guards` row after the effects.

For an ordinary request, a brief maintenance fence can defer its already prepared transaction:

```ts
const statements = await mutationStatements(c, mutation);
await executeMutationBatch(c, statements, { metadata_fence_wait_ms: 2500 });
```

`mutate` uses this executor automatically. It attempts the frozen statement list once and retries it at most once, only after the observed local acquisition is confirmed released. The default wait budget is 2,500 ms and its maximum is 3,000 ms. Polls are read-only, primary-backed and deadline-bounded. A replacement fence stops the wait. The retried transaction still contains every original credential, policy, public-revision/resource and idempotency-generation guard; no native validation, allocation, ID, event or authority snapshot is recreated.

Migration `097_metadata_fence_wait.sql` distinguishes the ordinary metadata-fence abort from other CAS failures. Only that named transactional abort can defer; uncertain commit acknowledgements, revision conflicts and wrong/released owner receipts do not. A fence still held at the deadline returns `423 repository_metadata_busy` with `Retry-After: 1`. Custom batch callers must prepare once and pass the existing statements to `executeMutationBatch`, retaining their normal non-fence error mapper.

Operations acquire the local fence before declaring a backup/copy barrier established. All other metadata producers must use the same commit guard or be quiesced. Owner progress, identity-associated source events and bookkeeping can still change live control rows, so paged backup data comes from an immutable, consistently materialized snapshot rather than rereading changing live tables.

## Consistency and recovery

Account epochs are monotonic. Acquiring a policy barrier advances the primary epoch, closes enrollment, installs blocked fences everywhere, records acknowledgements and only then permits the policy transaction. Releasing advances it again and installs the current policy revision before reopening admission. Delayed installation cannot regress a shard's fence. A failed or lost acknowledgement is never interpreted as completion.

Migration `090_authority_routing.sql` belongs in every core shard, including the identity primary. Its safeguards reject access-changing primary writes that bypass a required distributed barrier. The explicit recovery helper replaces blind deletion of expired distributed policy barriers.

Research: [D1 batches and Sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/) (checked 2026-10-05) documents batch rollback within one database, primary-first session freshness, and sequential consistency. A primary read followed by a write to a different D1 database is not one transaction; the acknowledged fence protocol closes that gap.

## Verification

`npm exec -- vitest run tests/high-level/request-recovery.test.ts tests/high-level/routing.test.ts` passed **23 checks** on 2026-10-05. The routing suite runs the real shard mover across independent SQLite D1 adapters, asserts destination enrollment and historical locator backfill before any public lookup, and exercises current primary grants, in-flight revocation, lost release acknowledgements, global operations/runs, pending request identity at cutover, identity-owned runner resources, private-fork audiences, and lifecycle recovery.

The metadata-fence journey uses the real operations acquisition/release helpers. Both a fully prepared write and a previously routed request authorized after fencing are rejected while repository state and all revisions remain unchanged. Exact-owner progress succeeds; another operation, a released owner receipt and reacquisition of that released identity are rejected. The workerd alias journey additionally verifies that a held repository fence blocks repository metadata while allowing identity-owned storage with a repository permission scope.

The bounded-defer proof releases maintenance after 1.3 seconds and verifies the identical prepared statement objects, one planned resource ID, one source event/audit, and the original idempotency generation. Policy, public repository revision, credential and generation changes still reject the retried transaction. A fence held beyond the budget returns explicit busy status with `Retry-After` and no resource effects. Actual workerd also verifies the named SQLite trigger-abort classification used by this path.

The cross-cell stream journey sends 6 MiB through the real upload handler, checks bounded producer progress while its sink is paused, verifies bytes/checksum and rejects an altered credential envelope. Moving/deleted cleanup reaches the independent attempt-proof gate while result callbacks remain fenced.

A separate actual-workerd journey binds `DB`, `IDENTITY_DB`, and `DIRECTORY_DB` to one physical D1 database. Repository and identity-owned writes use the colocated atomic path, keep distinct initial idempotency scopes, and create no spurious distributed placement registrations. These tests make no production cloud calls.
