# Identity, authorization, and repository catalog

## Integration contract

Identity owns migrations `001`–`019`, `packages/core/src/auth.ts`, `packages/core/src/policy.ts`, and the identity/accounts/repositories API modules. Register `registerIdentityRoutes(app)`, `registerAccountRoutes(app)`, and `registerRepositoryRoutes(app)`. The shared core exports remain `authenticate(request, env)`, `authorize(c, capability, scope)`, and `getRepository(c, id, capability?)`.

The API dependencies added are **`@simplewebauthn/server@14.0.3`** and the local **`@gitknot/billing`** workspace. Core depends on the local **`@gitknot/federation`** workspace through its authorization-only `integration` subpath. Password hashing uses native `node:crypto` scrypt with the OWASP memory-constrained profile `N=16384,r=8,p=5` (16 MiB), a random 16-byte salt, and a 32-byte result. No additional password or OTP library is required.

`IDENTITY_KEYS_JSON` is an authentication-only secret with shape `{ "current": "v1", "keys": { "v1": "<base64url of at least 32 random bytes>" } }`. The existing `SESSION_KEY` binding (at least 32 random bytes) is supported as initial key version `session-v1`. Retain old key versions while referenced by TOTP factors or unexpired actions. When migrating from `SESSION_KEY`, the `session-v1` key-ring entry must be the base64url encoding of the old binding's **UTF-8 bytes**, because that is the original derivation material. Domain-separated HKDF derives TOTP seeds from a per-user random salt; seeds, passwords, recovery codes, and bearer credentials are never stored in plaintext. This key does not decrypt workflow/tenant secrets, whose encryption keys remain exclusively in the secrets broker.

### Authoritative tables

- `users`, `accounts`, and `repositories` retain every common column in `implementation-contract.md`.
- Human `users.id`, `principals.id`, and personal `accounts.id` are the same stable `u_…` ID. Organization `accounts.id` is `org_…`. Every account has its own policy revision.
- `principals` also holds applications, services, agents, runners, jobs, and expiring viewers. Machine principals never own an organization. Their permission grants are distinct from their credentials.
- `roles` / `role_capabilities` describe built-in and account/repository-scoped custom roles. `memberships`, `teams`, `team_members`, and `access_grants` are the current grant authority. `member` means organization membership without implicit private-code access; `billing_manager` does not acquire internal code access merely from billing membership.
- `credentials` stores `token_hash` (SHA-256), kind, JSON capability/repository/account/ref/path scopes, parent credential, expiration/revocation, MFA evidence, user authentication epoch, and last-used time. All non-session credentials have explicit capabilities and a finite expiry. Session cookies are `__Host-gitknot_session` on HTTPS; development/test HTTP uses `gitknot_session`.
- `identity_actions`, `passkeys`, `user_mfa`, and `recovery_codes` support one-use challenges and replay-safe factors. Authentication actions bind to the user's current authentication epoch. Password reset invalidates old credentials.
- Identity's `repository_transfers` table in `004_repository_catalog.sql` is canonical. Its `operation_id` links to core `operations`; it also has stable `id`, destination name, previous lifecycle state, state, acceptance, expiry, and audit fields. An operations migration must not assume its older, narrower `IF NOT EXISTS repository_transfers` declaration defines the actual table.
- `repository_rules`, `rule_bypasses`, `repository_aliases`, `repository_lifecycle`, and `repository_exports` hold catalog adjuncts. All catalog provider/backend fields remain internal.

Identity reads and writes use `identityDatabase(c)` / `identityBinding(env)`, whose authority is `IDENTITY_DB ?? ROOT_DB ?? DB`. Explicit identity bindings require `IDENTITY_CELL_ID` and `IDENTITY_SHARD_ID`. Preserve all three with `identityAuthorityBindings(env)` before overriding a metadata database binding. Physical colocation uses these descriptors; D1 binding aliases are not comparable by JavaScript object identity. See [routing and authority fences](routing.md).

Account and repository-scoped memberships, grants, custom roles, invitations, and credentials all live on this identity authority. Repository grant routes select it with `selectIdentityDatabase(c)` before admission and idempotency capture. Repository metadata and adjunct mutations retain their routed `database(c)`. Mandatory organization rules are primary identity records; repository rules and bypasses are placement-local. Seeded identity rows are foreign-key material only.

### Authorization semantics

`explainAuthorization` is an internal nonthrowing evaluator. An API must first verify resource visibility before returning an explanation; evaluating another principal requires `permissions.explain`. An explicit deny wins over ownership, membership, visibility, and all other allows. Effective access intersects each credential ancestor's scopes with the principal's current grants and account policy. Revocation and policy reads use the primary; no eventually consistent permission cache grants access.

Grant conditions are a strict object: `{refs?: string[], paths?: string[], require_mfa?: boolean, not_before?: RFC3339, expires_at?: RFC3339}`. Globs support literal characters, `?`, segment-local `*`, and recursive `**`; matching is bounded dynamic programming. Ref/path conditions constrain Git writes, never the confidentiality of cloned history. Conditional writes require the complete ref and changed-path context. Deny path conditions match any changed path; allow path conditions must cover every changed path. Native publication must recheck each ref and its complete path set, then fence on `policy_revision`, `account_policy_revision`, `routing_epoch`, and credential state before publication.

Public and unlisted repositories allow content reads; only public repositories enter public listing/discovery. Internal visibility requires organization ownership and a current non-billing-only membership, unless an explicit additional grant is permitted. Private forks continuously require the underlying principal to remain in the source audience; a fork-only credential need not include the source ID. The ancestry check is transitive, cycle-bounded, and fail-closed.

Browser cookie mutations require an exact configured origin and `X-GitKnot-CSRF: 1`. Recent independent human session authentication is required for personal security administration. Listing account sessions additionally requires account-scoped `tokens.read`; revoking another session requires account-scoped `tokens.revoke`. Current-session self-revocation remains available.

The SQLite `identity_effective_owners` view and post-state guards protect the final independently recoverable organization owner. They include principal disablement/expiry, password/passkey recovery, local and organization MFA requirements, session/capability ceilings, and direct or team-derived account-wide denials. Membership/team mutations, role-capability changes, security changes and personal disablement cannot bypass the invariant. Scheduled critical denials count; expired denials do not. The capability view uses one `json_each` SELECT to remain within workerd/D1's compound-query limit.

Viewer issuance checks the issuer's effective permission for every requested capability before creating its principal or grants. Viewers receive only those explicit capabilities. Cross-principal credential rotation also rechecks delegation; the mutation retains the checked scope's authority versions.

### Operations and mail

Repository create/import/fork/transfer/export/delete/restore return visible core operation resources. The API transaction commits catalog state, the operation, and an outbox event together; it never reports provisioned storage before the operation worker verifies it. Backend storage names derive from the stable repository ID and survive rename/transfer. Native storage orchestration is owned by `@gitknot/operations` / `@gitknot/git` as documented in `docs/lifecycle.md` and `docs/git.md`.

Verification/recovery/invitation outbox events carry only an action or invitation ID. The mail consumer must reread its current, unconsumed record and obtain the deterministic short-lived token with `actionToken` from `@gitknot/core/auth`. It must never place the token in an outbox event, workflow checkpoint, diagnostic, or public webhook. For invitations use purpose `invitation`, the invitation `id`, `key_id`, and `expires_at`. Authentication action purposes are `verify_email`, `recover_password`, and `change_email`.

The billing integration uses `previewSeatChange(env, {account_id, additional_seats})` and a valid seat reservation consumed in the membership transaction. An invitation response includes the payer and exact seat quote before acceptance.

An active grant or membership is not billing evidence. Seat ownership is the explicit founding seat (`accounts.initial_seat_principal_id`, with the existing owner baseline as a compatibility fallback) plus consumed-reservation-backed seat events and removals. Account-wide human allow grants require both accepted active membership and a positive seat balance, checked again in their atomic transaction. Repository-only consent does not admit a person to organization-wide access.

Background scheduled integration invokes **`sweepRepositoryCatalog(env)`** from `apps/api/src/modules/repositories.ts`. It includes **`sweepIdentity(env)`**, reconciles abandoned metadata barriers, and expires unaccepted transfers with transactional outbox/audit records without starting native work. The background sweeper already registers it and the federation state sweeper. Transfer creation inserts `operation_dispatches.next_attempt_at='9999-12-31T23:59:59.999Z'`; acceptance atomically makes dispatch due. An unaccepted transfer must never acquire a worker-owned native barrier.

`account_policy_barriers` is part of migration `002`. Account-wide permission changes insert a durable primary barrier, await `fenceAccountAuthority` acknowledgements from every enrolled placement, collect per-repository native barriers, and commit the new grants/policy and outbox under revision/fence guards. `releaseAccountAuthority` acknowledges the new policy before reopening admission. Recovery uses `recoverAccountAuthorityBarriers`, rather than blindly deleting expired fences. Credential/security changes fence affected personal and principal accounts; membership-triggered scoped credential revocation includes those accounts too. Multi-account acquisition is ordered by account ID.

Repository visibility, ownership, deletion and other audience changes wrap native coordination in an account-epoch barrier. Transfer acceptance fences both accounts. Personal disablement fences all affected memberships/grants and credential accounts and rechecks owned repositories under the fence. A stale request cannot commit after recovery removes its fence. Native release uses the exact operation ID and token and retains cancellation tombstones, including a failed acquisition. `catalog_barriers` lives on the primary and contains private lock tokens, never bearer credentials or public output fields.

Routing integration: `routeRepositoryRequest` must allow authorized recovery/transfer-management paths to reach policy/handlers when directory state is `deleted`/`fenced`/`moving`; a blanket early 404/423 on those states makes restoration or receiver acceptance unreachable. Normal content reads/writes still use the directory fence and current policy.

Operation inputs include `principal`, `source_repo_id` for forks, `source_url` plus optional `source_secret_id` for imports, `recovery_until` for deletion, `archive_id` for chosen restores, and `export_id` for export records. Retain deletion archives through `recovery_until` plus cleanup headroom when configuring a recovery window longer than the default 30 days. `repository_transfers.accepted_principal_json` preserves the receiver's credential scope/MFA evidence for current-state worker reauthorization; `destination_policy_revision` records the accepted policy. Public transfer serialization omits both.

Job checkout credentials issued under a human principal must retain the initiating authenticated MFA evidence (`credentials.mfa`), as well as their parent/scope/expiry. Human organization access with `require_mfa` is still checked for such delegated credentials. Machine principals are governed by explicit grants, allowed credential kinds, expiry, and capability ceilings rather than interactive MFA enrollment.

`commitIdentity` uses the shared `mutationStatements` helper: the request generation, original credential versions, policy/routing preconditions, effects, outbox, audit and idempotency receipt share one transaction. `authorize` preserves `captureMutationAuthority` and `recordRequestPolicy`. Cross-placement decisions also retain account epochs before grant/audience evaluation, including private-fork ancestry. The previous metadata-shard predicates against copied credentials and account barriers have been removed. Replay reenters an authorized current-resource read instead of storing credential-bearing response bodies.

Catalog listing and name resolution use retained rows and enrollment records only to discover IDs. `readRepositoryAuthority(c,id)` resolves each ID's current placement independently; authorization, final metadata, owner/state/visibility filters, private-fork sources and visibility decisions use that authority. Public owner names come from the identity primary. `/v1/repos`, user repository lists and organization repository lists accept `visibility=public|private|internal|unlisted`; invalid values return 422. Filtering never widens access or makes unlisted repositories discoverable to callers without an explicit grant. Filtered pages may be empty with a non-null cursor when the bounded discovery window contains only inaccessible or nonmatching repositories; clients must continue until `next_cursor` is null.

Complete exports use Ops' persisted `archive_audiences` and `audience_sha256`. Listing, detail and download require base export permission and current access to every historical source. Unauthorized export metadata is hidden. Downloads check before response headers, start fresh primary-backed sessions for streamed authorization, and recheck after storage reads before releasing chunks. Revocation can terminate an already-started response without releasing subsequent protected data.

Migration **`019_identity_federation_scoping.sql`** integrates federation invalidation with normal account flows. Membership/team additions invalidate the affected federation assurances, while changes/removals revoke corresponding federation credentials and explicit account/repository-scoped credentials. They preserve unrelated normal personal sessions. `018_federation.sql` and the federation package remain intact, including SCIM deprovisioning and provider/policy revocation. Apply both migrations in the full application schema.

Organization repository creation grants the creator `default_repository_creator_role` from the account policy (Administrator by default), scoped only to that new repository. This makes private repositories usable for members with `repositories.create` while preserving organization policy ceilings. Deleting a fork expires its source-retention pin at the recovery deadline; a requested restore pins the source again until reconciliation completes.

## Research

Checked against current upstream documentation and the package registry on 4 October 2026:

- [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server) and the published `14.0.3` declarations: registration/authentication verification, exact RP/origin, user verification, challenge and signature-counter handling.
- [Workers `node:crypto`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/): native scrypt supported; native Argon2 unavailable.
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): memory-constrained scrypt parameters.
- [D1 batches and Sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/): transactional rollback and primary freshness.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) (rechecked 5 October 2026): per-statement limits also apply inside batches. Fresh migrations are exercised with the infrastructure script against isolated local workerd state.

## Stored repository rule contract

`repository_rules.config_json` is a strict version-1 rule document. `target_json` repeats its `target` array for indexed/read-side selection. Organization rules have `repo_id=NULL` and are mandatory; repository rules can strengthen them. Active rules compose by intersection; an evaluating rule reports obligations without granting a bypass. Native Git and the merge gate must consume these exact optional fields, including the additions to the initial native `GitRule`:

```ts
type CheckExpression =
  | { type: 'check'; key: string; producers: string[]; workflow_digest?: string;
      paths?: { include: string[]; exclude: string[] } }
  | { type: 'all' | 'any'; checks: CheckExpression[] };

type RepositoryRule = {
  version: 1;
  target: string | string[];
  updates?: 'any' | 'pull_request_only' | 'blocked';
  history?: { allow_force_push?: boolean; allow_deletion?: boolean; allow_creation?: boolean; linear?: boolean };
  files?: { denied_paths?: string[]; allowed_paths?: string[]; max_bytes?: number;
    block_secrets?: boolean; inspect_all_supplied_objects?: boolean };
  signatures?: { commits?: boolean; tags?: boolean; annotated_tags?: boolean };
  reviews?: { minimum?: number; disallow_author_approval?: boolean; resolved_threads?: boolean;
    required_owners?: Record<string, string[]>; required_reviewers?: string[] };
  verification?: { required: string[]; revision: 'merge_candidate'; trusted_producers: string[];
    expression?: CheckExpression };
  merge_strategies?: ('merge' | 'squash' | 'rebase' | 'ff-only')[];
  push?: { allowed_principals: string[] };
  bypass?: { capability: 'rules.break_glass'; reason_required: true; maximum_duration_seconds: number };
};
```

Expression depth is at most 8 and total leaves at most 64. A check's `producers` are trusted immutable producer identities, not display names. Required legacy keys need nonempty `trusted_producers`; producer IDs and workflow digests remain part of merge-result provenance. Path conditions can declare a leaf inapplicable only from the trusted rule document. An `any` expression cannot be flattened into `required[]` without changing its semantics. Unknown fields must fail closed in native admission. The rule API validates scoped reviewer/team IDs and rejects contradictory merge strategies and obvious contradictory path/push constraints.

Break-glass grants are rows in `rule_bypasses`: `rule_ids_json`, `refs_json`, actor, reason, `policy_revision`, `expires_at`, and `revoked_at`. They last at most 1,800 seconds and cannot include mandatory organization rules. The native gate must reauthorize `rules.break_glass`, validate scope/expiry/current policy revision, and retain the bypass ID/reason in its operation audit.

`invitations.principal_json` retains the issuer's authenticated scope/MFA evidence. A durable invitation is independent of a browser session's logout, while acceptance rechecks the issuer's current principal and roles plus the saved credential scope. Mail can use the same snapshot for MFA-governed organizations instead of replacing a known authenticated issuer with an MFA-false synthetic principal.

## Federation hooks and credential issuance

- `authenticate` applies `restrictFederatedPrincipal` after checking the credential and every ancestor. It intersects assurance account scopes across the ancestry and validates the configured integration marker for federation-originated authentication.
- Organization/repository authorization calls `enforceOrganizationSso`. Anonymous/public visibility remains public; federation-originated credentials still obey their provider's explicit ceilings/denials. Denials become permission-explanation reasons, exposed only through an already-authorized explanation route.
- `requireHuman(c, {independent:true})` checks `isFederationSession` across the complete credential ancestry. Passkey/MFA management, password/email changes, global profile/security management and ownership recovery require an independent session. Fresh local password/passkey authentication is independent proof; a session refresh is credential derivation.
- `prepareDerivedCredential(db, sourcePrincipal, input)` returns `{credential, token, statements}`. Commit **all** statements together. It calls the federation package's real `federationCredentialStatements`; it preserves authentication time and the earlier assurance expiry. The source principal must be the actually authenticated issuer, not an identity reconstructed from another credential's metadata.
- Personal/viewer/service token issuance, personal-token rotation and session refresh use the derived helper. Federation-derived personal tokens remain in the verified human's scope. Local sessions cannot rotate an SSO credential to copy its assurance. Job/runner credentials cannot use generic token rotation to escape their lifecycle's revocation.
- On rotation, insert the new credential and copied assurances **before** revoking the source in the same transaction, so the federation source guard can verify it. All one-time values remain non-replayable.

The hooks are implemented and verified. The parent can enable `FEDERATION_IDENTITY_CONTRACT=gitknot.identity.federation.v1` in the appropriate API/Git/broker bindings after its remaining composition is connected. The narrow SAML ACS middleware exemption remains parent-owned.

Other derived-credential issuers must consume the hook too. In particular, `packages/execution/src/checkout.ts` uses deterministic retry-safe credentials and must append `federationCredentialStatements` in its initial guarded issuance, preserving the existing credential on retries; it also needs the initiating MFA evidence. `packages/execution/src/reproduce.ts` can use `prepareDerivedCredential` with the actual actor's `user_id` and authentication revision instead of null values. Both must commit the original parent and all federation statements atomically with issuance. `source.ts` already preserves an existing authenticated actor; its no-credential inspection path must remain independently authorized. Independent machine enrollment remains a separate authorized identity lifecycle.

## Route inventory

The three registration functions register **164 method/path pairs**, all through the shared OpenAPI registry. The following notation expands exactly: `A=/v1/accounts/:id`, `O=/v1/orgs/:id`, `R=/v1/repos/:id`; comma-separated suffixes denote separate endpoints.

| Methods | Paths |
| --- | --- |
| POST | `/v1/auth/signup`, `/v1/auth/login`, `/v1/auth/login/mfa`, `/v1/auth/logout` |
| POST | `/v1/auth/verify`, `/v1/auth/verify/resend`, `/v1/auth/recover`, `/v1/auth/reset`, `/v1/auth/reauthenticate` |
| PUT | `/v1/auth/password` |
| POST | `/v1/auth/email`, `/v1/auth/email/verify` |
| GET, PATCH, DELETE | `/v1/me` |
| GET | `/v1/users`, `/v1/users/:id`, `/v1/users/:id/repos` |
| GET | `/v1/auth/session`, `/v1/auth/sessions` |
| POST | `/v1/auth/session/refresh` |
| DELETE | `/v1/auth/sessions/:id` |
| GET, PUT | `/v1/auth/mfa` |
| POST | `/v1/auth/mfa/totp/setup`, `/v1/auth/mfa/totp/verify`, `/v1/auth/mfa/recovery-codes` |
| DELETE | `/v1/auth/mfa/totp` |
| GET | `/v1/auth/passkeys` |
| PATCH, DELETE | `/v1/auth/passkeys/:id` |
| POST | `/v1/auth/passkeys/registration/options`, `/v1/auth/passkeys/registration/verify`, `/v1/auth/passkeys/authentication/options`, `/v1/auth/passkeys/authentication/verify` |
| GET, POST | `/v1/tokens` |
| GET | `/v1/tokens/current` |
| GET, PATCH, DELETE | `/v1/tokens/:id` |
| POST | `/v1/tokens/:id/rotate` |
| GET, POST | `/v1/orgs` |
| GET | `A`, `O/repos` |
| GET, PATCH, DELETE | `O` |
| GET | `O/members` |
| GET, PATCH, DELETE | `O/members/:principalId` |
| GET, POST | `O/teams`, `O/teams/:teamId/members` |
| GET, PATCH, DELETE | `O/teams/:teamId` |
| PATCH, DELETE | `O/teams/:teamId/members/:principalId` |
| GET, POST | `O/invitations`, `R/invitations` |
| DELETE | `O/invitations/:invitationId`, `R/invitations/:invitationId` |
| POST | `O/invitations/:invitationId/resend`, `R/invitations/:invitationId/resend` |
| GET | `/v1/invitations`, `/v1/invitations/:invitationId` |
| POST | `/v1/invitations/:invitationId/accept`, `/v1/invitations/:invitationId/decline` |
| GET | `/v1/capabilities` |
| GET, POST | `A/roles`, `O/roles`, `R/roles` |
| GET, PUT, DELETE | `A/roles/:roleId`, `O/roles/:roleId`, `R/roles/:roleId` |
| GET, PUT | `A/policy`, `O/policy` |
| POST | `A/policy/preview`, `O/policy/preview` |
| GET, POST | `A/grants` |
| DELETE | `A/grants/:grantId` |
| GET, POST | `A/identities`, `O/identities` |
| PATCH, DELETE | `A/identities/:principalId`, `O/identities/:principalId` |
| GET, POST | `A/applications` |
| PUT, DELETE | `A/applications/:applicationId` |
| GET | `/v1/applications/:applicationId` |
| GET, POST | `A/installations`, `O/installations` |
| GET, PATCH, DELETE | `A/installations/:installationId`, `O/installations/:installationId` |
| GET, POST | `/v1/repos` |
| GET | `/v1/repos/resolve/:owner/:name` |
| GET, PATCH, DELETE | `R` |
| GET, POST | `R/permissions/explain`, `R/collaborators`, `R/access-reviews` |
| PUT, DELETE | `R/collaborators/:grantId` |
| GET | `R/access-review` |
| GET, POST | `R/rules`, `O/rules` |
| POST | `R/rules/preview`, `O/rules/preview` |
| GET, PUT, DELETE | `R/rules/:ruleId`, `O/rules/:ruleId` |
| GET, POST | `R/rule-bypasses` |
| DELETE | `R/rule-bypasses/:bypassId` |
| POST, DELETE | `R/archive` |
| POST | `R/restore` |
| GET, POST | `R/exports`, `R/transfers` |
| GET | `R/exports/:exportId`, `R/exports/:exportId/download` |
| GET, DELETE | `R/transfers/:transferId` |
| POST | `R/transfers/:transferId/accept` |

### Important request schemas

- Sign-up: `{username,email,password,display_name?}`; passwords are 15–256 characters and at most 1,024 UTF-8 bytes. Login: `{login,password}`, where `login` is username or email. A second-factor challenge returns `202` with `token`; complete it with `{token,code? | recovery_code?}`.
- Verification/recovery completion: `{token}` and `{token,password,code?,recovery_code?}` respectively. Email-only recovery never bypasses an enrolled local factor.
- Tokens: `{name,kind?,principal_id?,capabilities:string[],repository_ids?:string[],account_ids?:string[],ref_patterns?:string[],path_patterns?:string[],expires_at}`. Capabilities are concrete, scopes nonempty, expiry mandatory, and source/account ceilings remain enforced. Default personal maximum is one year, account default ceiling 90 days; installation tokens max one hour, service/agent tokens one day, viewer grants seven days.
- Invitations: `{email,role_id?,team_id?,expires_in_seconds?}`. Acceptance: `{token,seat_quote:{subscription_revision,plan_id,maximum_monthly_units,maximum_current_period_units}}`; monetary quantities are decimal strings. Use the invitation ETag in `If-Match`.
- Repository creation: `{owner_id,name,description?,visibility?,default_branch?,fork_source_id?,import?:{source_url,source_secret_id?},workspace?}`. Fork/import are mutually exclusive. Workspace repositories are private. The response is a redacted catalog resource plus a durable pending operation with `202`.
- Collaborator/account grants: `{principal_type,principal_id,role_id? | capability?,effect?,conditions?,expires_at?}`. Exactly one role/capability is required. New outside human collaborators use the invitation/seat-consent flow.
- Custom roles: `{name,description?,capabilities:[{capability,effect}]}`. Explicit capabilities cannot exceed the assigning principal's authority; built-ins and inherited roles are immutable in the child scope.
- Rules: `{name,enforcement?:"active"|"evaluate"|"disabled",config:RepositoryRule}` using the typed contract above. Preview accepts `{rule,replace_rule_id?,ref?,paths?}`.
- Transfers: `{destination_owner_id,destination_name?,expires_in_seconds?}`. Receiver acceptance is a separate authenticated, revision-checked action. Archive accepts `{archived?:boolean}`; restore accepts `{archive_id?}`; complete export accepts `{}`.

## Verification

`tests/high-level/identity.test.ts` has seven HTTP/D1 journeys: password/MFA/recovery and replay, cryptographically verified passkeys, invitation seats and concurrent owner safety, visibility/token/private-fork boundaries, SSO derivation/rotation/independent recovery, complete-export audience revocation during streaming, and routed-authority reads/writes. The publication fixture uses the production journal's operation-scoped acquisition/release contract and cancellation tombstones.

The regression journeys include denied-capability viewer issuance and rotation, account-wide unpaid outside grants, team-derived loss of the final effective owner, personal disablement with an already-denied remaining owner, repository-only token attempts to administer sessions, retained-public/current-private catalog discovery, and hidden/terminated exports after historical-source revocation.

On 5 October 2026:

- All **7 identity journeys** and **10 routing journeys** passed.
- **21 of 22 actual-workerd federation scenarios** passed. The remaining scenario fails at provider-create idempotency because its worker fixture lacks the newly required `IDENTITY_KEYS_JSON` binding; this is reported to the federation owner.
- The fresh core schema, including `005_identity_safeguards.sql` and `090_authority_routing.sql`, passed `scripts/migrate.ts --local --database core` in isolated workerd state.
- Identity/account/catalog and the owned journey file have no TypeScript diagnostics in the full-project check. That check currently reports errors in concurrently developed storage, execution, runner and Ops code.
