# Organization federation and SCIM 2.0

GitKnot supports organization OIDC authorization-code sign-in, SAML 2.0 Web SSO, explicit identity linking, and SCIM 2.0 Users/Groups. Organization identity uses the authoritative core users, principals, memberships, teams, and credentials.

## Required composition

The implementation is isolated in `packages/federation`, `apps/api/src/modules/federation.ts`, and `migrations/018_federation.sql`. Apply the identity/core migrations before the federation migration.

1. API composition calls `registerFederationRoutes(app)`.
2. **Core authentication** calls `restrictFederatedPrincipal(db, principal)` after verifying the current core credential and every ancestor. It returns a narrowed `Principal` or `null`. Core sessions have the existing `session` credential kind and `gks_` cookie format; this hook applies the additional organization scopes stored in `federation_session_grants`.
3. **Core authorization** calls `enforceOrganizationSso(db, principal, accountId, capability)` before allowing organization-derived access, including repository access through its owning organization. Ordinary grant/credential/policy checks still apply. This hook enforces current provider/SCIM membership, verified MFA, freshness, provider and policy revisions, and explicit capability ceilings/denials. A provisioned or linked human always needs its provider authorization for that organization; `required: true` additionally covers other human organization members.
4. **Credential derivation** commits the statements returned by `await federationCredentialStatements(db, sourcePrincipal, preparedCredential.credential)` in the same batch as `prepareCredential(...).statement`. The copied grants retain the original authentication time, provider binding, and earliest expiry. Account-security changes that require independent recovery must reject federation-only sessions; `isFederationSession(db, credentialId)` is exported for this check. Federation linking already applies it.
5. **SAML protocol boundary:** skip ambient cookie authentication and ordinary browser-CSRF middleware only when `isFederationProtocolCallback(request)` from the API module returns true. It selects exactly `POST /v1/auth/saml/idp_…/acs`. The handler independently requires the browser-bound, one-use RelayState cookie and validates the complete signed SAML response. Cookie-authenticated management and link-start requests retain Origin and `X-GitKnot-CSRF: 1` checks.
6. The private `SECRETS` Worker dispatches `/internal/federation/*` to `handleFederationBrokerRequest(request, env, context)` from `@gitknot/federation/broker` **before** the ordinary vault scope router. This handler authenticates its own narrow purpose grants, rechecks administrative identity, and operates the encrypted federation secret tables.
7. Scheduled maintenance calls `sweepFederationState(db, maximum = 1000)` to delete expired flow, replay, rate-limit, and SCIM idempotency records in bounded batches. Expiry/revocation checks do not depend on the sweeper.

Set `FEDERATION_IDENTITY_CONTRACT=gitknot.identity.federation.v1` only after these identity hooks are connected. Authentication, provisioning, linking, and management fail with `503 federation_unavailable` when the marker or required recovery/revocation triggers are missing. The package does not substitute an in-memory production authority.

The `@gitknot/federation/integration` subpath contains the core hooks. It avoids pulling the protocol adapters into authorization-only bundles.

### Core schema interface

The D1 exchange uses the actual core exports `prepareCredential`, `credentialIsCurrent`, `credentialScope`, `requireHuman`, `requirePrincipal`, and `authorize`. The SQL adapter in `identity.ts` is the schema adaptation boundary:

- `prepareManagedUser(db, {email, display_name, verified, actor_id})` returns a managed human and user/principal insert statements. Its generated GitKnot username is distinct from SCIM `userName`. Managed people have no fabricated password or automatically created personal account.
- `exchangeFederatedIdentity(db, provider, flow, verifiedIdentity, requestId, env?)` atomically admits replay IDs, verifies current identity/membership revisions, links/provisions the human, applies approved mappings, inserts a core session and organization assurance grant, and writes audit/outbox events. The API passes its billing-capable bindings as the sixth argument; a new paid-seat transition fails closed when those bindings are absent. Existing callers and core hook signatures remain compatible. It returns `{credential, token, user_id}` or `{pending_provisioning: true, user_id}` for a verified pre-link awaiting SCIM.
- `membershipStatements` and `revokeUserCredentials` are isolated statement builders. Owner assignment remains identity-owned. Federation never assigns the `owner` role, and existing ownership is preserved when synchronizing mapped roles.
- `credentials.kind='service'` represents a SCIM provisioning token. Its `user_id` and parent are null, `repository_ids=[]`, `account_ids=[org_id]`, and capabilities are a subset of the five exact `scim.*` operations. The associated service principal receives no organization role. The federation token registry additionally binds it to one provider.

The adapter consumes the current core/identity schemas, including `account_policy_barriers` in `002_authorization.sql` and generation-fenced request receipts in `000_idempotency_recovery.sql`. `federationMutation(c, mutation)` uses core `mutationStatements` for public metadata writes, committing effects, source event, audit and retry receipt together. Its migration does not alter the common tables. Federation triggers invalidate the affected organization's assurance and bounded credential families in the membership/team transaction, and increment `accounts.policy_revision`. B-only credentials and unrelated organization assurance remain valid. Shared local logins retain access to other organizations; current ACLs and the invalidated A assurance block the removed organization. Descendants of an actually revoked credential remain revoked through the ordinary global ancestor checks.

## Runtime and bindings

Use the project’s `cf/config` Worker configuration with Node compatibility. The adapter uses standard Worker Fetch, Web Crypto, D1, and service bindings, plus supported native `node:crypto`, `node:buffer`, and `node:zlib` APIs.

| Binding | Receiving Worker | Meaning |
| --- | --- | --- |
| `DB` | API and private broker | Same authoritative account/identity shard; all authorization state is read from the primary. |
| `ADMISSION`, `INTERNAL_SERVICE_KEY` | API | Real billing account coordinator and signed seat-cost admission. |
| `APP_ORIGIN`, `API_ORIGIN` | API and broker | Exact HTTPS origins. Callback, metadata, and final application URLs are constructed from them. |
| `FEDERATION_IDENTITY_CONTRACT` | API and broker | Explicit core-integration version above. |
| `FEDERATION_TRUSTED_ORIGINS_JSON` | API and broker | Operator-controlled JSON array of exact public HTTPS IdP origins, maximum 128. |
| `IDENTITY_KEYS_JSON` | API only | Explicit retained identity keyring for keyed request fingerprints. Legacy `session-v1` is `base64url(UTF8(SESSION_KEY))`. |
| `SECRETS` | API | Private secrets Worker service binding. |
| `SECRETS_CLIENT_ID`, `SECRETS_CLIENT_KEY` | API | Existing vault client binding convention; random, purpose-authorized service identity. |
| `SECRETS_FEDERATION_SERVICE_KEYS_JSON` | Private broker | `{client_id:{key,scopes,account_ids?:string[]\|null,repository_ids?:null}}`; distinct keys for distinct callers. |
| `SECRETS_KEK_KEYRING_JSON`, `SECRETS_KEK_CURRENT_ID` | Private broker only | Existing secrets-vault KEK binding convention, including Secrets Store `get()` bindings. |

Federation purpose grants use a separate map because the existing vault’s `BrokerScope` enum has an independent, strict catalog. The general `INTERNAL_SERVICE_KEY` does not authorize federation secret operations. Requests use the actual vault conventions `x-gitknot-service-client` and `signInternalRequest`; method, host, path, purpose, body digest, time and durable nonce are authenticated. Unique per-client keys bind the selected caller identity. Organization scope restrictions are enforced by the broker.

API needs `federation.manage`, `federation.exchange`, and `federation.sign`. A dedicated maintenance identity can have `federation.rotate`.

### Network boundary

Tenant administrators cannot extend `FEDERATION_TRUSTED_ORIGINS_JSON`. Operators approve controlled IdP origins with public DNS destinations. Exact origins are enforced for authorization URLs, discovery, token exchange and JWKS retrieval. IP literals, private/reserved hostname forms, credentials in URLs, fragments, non-HTTPS schemes, nonstandard ports, and endpoint query strings are rejected. Fetches refuse redirects, time out after five seconds, and accept at most 64 KiB of JSON. JWKS sets contain at most 32 public RSA/EC keys. Remote JWKS caching is bounded to 128 provider revisions, five minutes, with a 30-second miss cooldown.

`return_to` is a bounded relative application path. State/RelayState never contains a return URL, user ID or authorization decision.

## Versioned endpoints

All routes are registered with the shared route/OpenAPI registry. `GET /v1/auth/federation/discovery` publishes protocol versions and endpoint templates. The complete API document is `/v1/openapi.json`.

### Organization administration

Base: `/v1/orgs/:orgId/identity-providers`.

| Method/path | Operation |
| --- | --- |
| `GET`, `POST` base | List providers or create a disabled provider. |
| `GET`, `PATCH`, `DELETE /:providerId` | Inspect, update/enable, or soft-delete a provider. |
| `GET`, `PUT /policy` | Read/set required SSO, session maximum age, and scoped-machine policy. |
| `POST /discovery` | Discover an explicitly approved OIDC issuer; returned endpoints are revalidated and require deliberate configuration. |
| `PUT`, `DELETE /:providerId/secrets/:kind` | Rotate or revoke `oidc_client_secret` / `saml_signing_key` through the broker. Revocation disables the provider. |
| `GET`, `POST /:providerId/provisioning-tokens` | List or issue a provider-bound, expiring SCIM bearer token. The value is returned once. |
| `DELETE /:providerId/provisioning-tokens/:tokenId` | Revoke a provisioning token. |
| `POST /:providerId/credentials/:credentialId/authorize` | Bind the signed-in human’s personal token to a fresh organization SSO session and narrow its account scope. |

Provider management requires a currently verified human owner/administrator, credential scope and organization authorization, and MFA. Writes require authentication within five minutes. Revisioned mutations require the current strong `If-Match`; the initial absent policy is revision `"0"`. Create operations accept `Idempotency-Key`. One-time token values cannot be replayed. Secret-write retries use the broker's atomic operation journal and return only their original public metadata outcome. Up to 16 live providers are allowed per organization.

Issuer, client ID/token endpoint, tenant trust set/claim and immutable SCIM ID claim cannot be changed in place. Create a new provider for that trust identity. Certificate, endpoint and policy changes increment revisions and revoke prior assurance grants/flows. Removing the last enabled provider while required SSO is enabled requires an explicit policy change first. An independently authenticated recoverable owner can manage identity policy during IdP failure; that exception is limited to identity administration and requires local MFA within five minutes.

### Sign-in and linking

| Endpoint | Binding |
| --- | --- |
| `GET /v1/auth/oidc/:providerId/start` | Browser redirect for a new OIDC sign-in. |
| `GET /v1/auth/oidc/:providerId/callback` | Authorization code callback; `state`, `code`, and configured authorization-response `iss` validation. |
| `GET /v1/auth/saml/:providerId/start` | SAML HTTP-Redirect AuthnRequest. |
| `GET /v1/auth/saml/:providerId/metadata` | SAML service-provider metadata and public signing certificate. |
| `POST /v1/auth/saml/:providerId/acs` | SAML HTTP-POST form with exactly `SAMLResponse` and `RelayState`. |
| `POST /v1/auth/{oidc\|saml}/:providerId/start` | JSON `{intent:"login"\|"link",return_to?:"/relative/path"}`. Returns `{authorization_url,expires_at}` for browser navigation. |

Linking requires an already signed-in, verified GitKnot account with fresh **independent** local MFA, the allowed Origin, and `X-GitKnot-CSRF: 1`. The flow records that exact user, credential and authentication revision, and rechecks them on completion. A federation-only session cannot link additional identities.

In `scim_only` mode, an existing GitKnot user can pre-link a verified immutable provider identity without receiving membership or an SSO session. The browser returns with `identity_linked=true&provisioning_required=true`. A subsequent SCIM create selects that verified link by the configured external ID, and activates membership according to provisioning policy. SCIM email data never selects an existing account. Conflicting subject/external-ID bindings are rejected.

For a new managed user, SCIM creates an unverified account. First SSO verifies the same provisioned email under the configured tenant before marking it verified. Explicit `jit` policy allows a new verified provider identity to create a new managed account; an existing global email results in a linking conflict. SCIM can correct an unverified provisioned address but cannot overwrite a globally verified account email.

### OIDC configuration and evidence

Required configuration: `protocol:"oidc"`, exact `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`, `client_id`, `tenant_claim`, `tenant_values`, and `external_id_claim`. Authentication methods are `client_secret_basic`, `client_secret_post`, and explicitly public `none` clients. Every client uses authorization code + S256 PKCE.

Flows last five minutes. Cryptographically random state, nonce, verifier and a separate HttpOnly browser-binding cookie are generated server-side. Only hashes of state/browser/nonce are stored. Code exchange consumes the flow atomically; PKCE verifiers are cleared after use/failure. `jose.jwtVerify` enforces pinned asymmetric algorithms, signature, issuer, audience, required claims, expiration/not-before and issued-at age. Nonce, multi-audience `azp`, optional `at_hash`/`c_hash`, tenant, authentication time, and configured MFA assurance are also checked. Requests force fresh authentication. `amr` containing `mfa`, or an explicitly approved `mfa_acr_values` entry, is required.

### SAML configuration and evidence

Required configuration: `protocol:"saml"`, exact IdP `issuer`, `sso_url`, one to three current RSA `signing_certificates` (2048 bits minimum), and the same explicit tenant/external-ID/provisioning policy. Persistent NameID is the default; unspecified NameID is an explicit option. Configure immutable provider object IDs for account linking. `mfa_contexts` defaults to `https://refeds.org/profile/mfa`; password-only contexts cannot be configured as MFA.

By default both Response and Assertion signatures are required. The explicit `response_signature_required:false` mode still requires a signed Assertion, signed bearer SubjectConfirmationData binding the exact request/recipient, and validates any Response signature present. `xml-crypto` verifies signatures, canonicalization and reference digests. Claims are parsed only from `getSignedReferences()` output. Supplied KeyInfo never replaces configured trust anchors. Accepted signatures are RSA-SHA256, RSA-PSS-SHA256 and RSA-SHA512 with SHA-256/512 digests and bounded canonicalization/enveloped transforms.

Validation covers exact namespaces and cardinalities, signed subject, issuer, response/request InResponseTo, ACS destination/recipient, every audience restriction, issue/authentication times, not-before, not-on-or-after, and current MFA context. Durable unique assertion/response hashes prevent replay across different flows and concurrent callbacks. AuthnRequests force fresh authentication and are broker-signed by default. Metadata accurately advertises the signing policy and HTTP-POST ACS.

The accepted Web SSO profile is SP-initiated Redirect → POST with one plaintext, signed Assertion. XML is bounded to 128 KiB, 2048 elements, depth 32, and bounded attribute counts/values; the form is bounded to 512 KiB. DTDs, entity declarations, comments, CDATA, processing instructions, duplicate IDs, wrapping/multiple assertions, encrypted assertions and unsupported condition/transform forms are rejected before consuming identity claims. The XML parser does not fetch external entities.

## Mapping and assurance policy

`mappings` contains `default_role_id`, `role_claim`, `role_mappings:[{value,role_id}]`, `role_ceiling`, `capability_ceiling`, `denied_capabilities`, `denied_role_values`, `group_claim`, `team_mappings:[{value,team_id}]`, `scim_group_mappings:[{external_id,team_id}]`, and `team_ceiling`. Unknown roles/groups are denied by default. Multiple conflicting role mappings are denied. Mapped roles/teams must be currently valid in the owning organization; role grants must fit the deliberate capability ceiling. Explicit capability denials win.

SCIM `roles[].value` uses the same approved external-role mapping. SCIM Groups bind immutable external IDs to existing organization teams. Nested Groups are outside the advertised schema. A locally managed team membership cannot silently become provider-owned. Only tracked provider-owned memberships are removed during reconciliation. Membership removal uses current relational ownership inside the transaction; activation and SSO synchronization fence their membership snapshots to prevent stale team access during concurrent changes. Clearing `group_claim` reconciles an empty desired SSO team set. A configuration change that leaves provisioned Groups outside the current ceiling blocks new SSO until their memberships are reconciled.

SSO session maximum age defaults to one hour and is configurable from five minutes to twelve hours. Provider authentication must be fresh (default five minutes, maximum fifteen; requests force reauthentication). Grants preserve the IdP authentication time and MFA assurance, and are checked against current provider/policy revisions. Machine access is separately `deny` or deliberately account/repository/capability-scoped; wildcard machine scopes do not bypass required SSO.

## SCIM 2.0

Base: `/scim/v2/:orgId`. A provisioning token selects exactly one provider at that base.

- `Users` and `Groups`: `GET` list, `POST` create; `GET`, `PUT`, `PATCH`, `DELETE /:id`.
- `POST /Users/.search` and `/Groups/.search`: SCIM SearchRequest.
- `GET /ServiceProviderConfig`, `/Schemas`, `/Schemas/:id`, `/ResourceTypes`, `/ResourceTypes/:id`.
- Responses and errors use `application/scim+json`; error resources carry the SCIM Error schema, string status and appropriate `scimType`. Missing credentials include `WWW-Authenticate: Bearer`.
- Listing returns `ListResponse` with `Resources`, `totalResults`, one-based `startIndex` and `itemsPerPage`. `count` defaults to 100 and is capped at 100; zero returns the count alone. Offset is bounded at one million. Count, resource page and visible relationships use one D1 snapshot. Single-resource reads obtain metadata and relationships in one statement.
- Filters support `eq ne co sw ew pr gt ge lt le`, `and`, `or`, `not`, parentheses, and bounded value filters on emails, roles, phone numbers, group members and user groups. Paths are allowlisted and values are bound SQL parameters. Names/operators are case-insensitive; case-insensitive values use persisted NFKC/lowercase search representations. IDs/external IDs are case-exact. Invalid types/operators/paths return `invalidFilter`.
- `attributes` and `excludedAttributes` project each complex-array element independently and preserve always-returned IDs/schema. Selecting `emails.value` returns only each value; excluding `emails.primary` preserves the collection and its other fields. `ServiceProviderConfig` advertises filtering, PATCH and ETags; bulk, sorting and password change are false.
- PUT/PATCH honor `If-Match`. All writes compare revisions in a transaction even when a SCIM client omits the optional header. PATCH operations apply atomically; primary promotions clear the other values before the next operation runs. Immutable external IDs, read-only attributes, missing filtered targets and cross-tenant members are explicit errors. Strong ETags appear in `meta.version` and response headers. Group membership/name changes also update affected Users' revisions; User name/deletion changes update affected Groups' revisions in the same transaction.
- Create accepts an optional `Idempotency-Key`. Its organization/provider/credential/body-bound journal persists a generation, attempt ID and planned resource/user IDs. After a 30-second request lease, a retry can claim a higher generation; every effects batch fences the old writer by generation/attempt CAS. Resource, source event, audit and completion receipt commit together. Recovery verifies that receipt and returns a consistent current resource. `externalId` and normalized `userName` uniqueness also prevent duplicate provisioning.
- Supported User profile and enterprise-extension attributes are described exactly by `/Schemas`; arbitrary password changes are rejected. Requests are bounded to 256 KiB, PATCH to 100 operations, User collections to their schema bounds, and Groups to 1000 members.
- `active:false` suspends membership, removes provider-managed team access, suspends linked subjects and revokes corresponding credentials atomically. Reactivation keeps old credentials revoked and requires a fresh verified SSO exchange. DELETE retains a tombstone and immutable external identity for history/replay safety, returns 204, and hides the resource from GET/list. Use inactive/active transitions for routine suspend/rehire workflows. Last-recoverable-owner violations return a SCIM `409 mutability` error and roll back the complete operation.
- Only a live Group holds exclusive ownership of its team and provider external ID. A deleted Group keeps its historical server ID and team ID without a restrictive team foreign key, so a replacement Group may reuse the external ID/team with a new server Group ID. The team may be deleted after all live bindings are removed.

## Membership seat admission

SCIM creation/reactivation and JIT enrollment automatically call the real `@gitknot/billing` `previewSeatChange`, `reserveSeatChange`, `seatAcceptanceStatements`, and `cancelSeatReservation` protocol. The organization's configured provider policy authorizes provisioning; no per-person human seat approval is introduced. Existing active membership or a current outside-collaborator seat is counted once. New seats compete with invitation reservations against the current plan, billing revision and account budget. The shared acceptance statements, membership change and federation completion receipt commit in one transaction.

`federation_seat_admissions` records prospective billing inputs before the remote coordinator call. A crash/retry fences the old membership writer before releasing its unconsumed hold. `sweepFederationState` also reconciles expired/cancelling admission intents through the shared cancellation API; uncertain holds are retained until a receipt or billing-revision fence proves the outcome. Deprovisioning records one negative seat event/plan-segment transition only when the guarded prior state actually occupied a seat. It revokes that user's organization-scoped allow grants while preserving deliberate denials. The negative-seat adapter is isolated in `seats.ts`, following the current identity/billing segment/event contract; billing currently exposes no standalone shared reduction helper.

SCIM authentication runs before the shared route layer captures mutation authority. Its provider-bound registry supplies provisioning authority, while current account capability ceilings, credential-kind/lifetime policy, provider revisions, credential snapshots and account policy revisions are checked/fenced explicitly. SCIM credentials retain `repository_ids:[]` and receive no general organization role.

## Private broker envelope operations

`POST /internal/federation/secrets` seals a write-only OIDC client secret or matching SAML private key/public certificate. Inputs bind `account_id`, `provider_id`, administrative `credential_id`, `expected_revision`, `operation_id` (64-character hexadecimal retry identity), `kind`, and the new `secret` (`public_certificate` for SAML). The API derives the operation ID from the authenticated human, method/path and optional `Idempotency-Key`. The private broker reauthorizes every retry, uses a keyed input fingerprint, and commits its operation outcome with ciphertext and audit/event records. Each immutable secret version has a fresh random 256-bit DEK and separate 96-bit AES-GCM payload/wrap nonces. Authenticated context binds organization, provider, purpose, version and OIDC issuer/client/token endpoint. Only ciphertext, keyed fingerprints and public metadata are stored in D1.

`POST /internal/federation/exchange` consumes a persisted, browser-validated flow and exchanges its code/verifier using the secret internally. It returns the bounded OIDC tokens for verification, discarding refresh tokens and unrelated fields. `POST /internal/federation/sign` signs only a currently persisted SAML flow’s exact AuthnRequest/RelayState. Neither operation is a generic decryption/signing oracle.

`POST /internal/federation/secrets/revoke` revokes a version and disables its provider, using the same durable management operation ID. `POST /internal/federation/rewrap` is limited to `federation.rotate`, with `{after?,limit?:1..100}`. It verifies payload integrity, appends immutable wrap records under the configured current KEK and returns `next_cursor`; payload ciphertext stays unchanged. Retain old KEKs until all latest wraps have been traversed/verified. Recovery restores federation ciphertext, wrap rows, configuration and independently protected KEKs together with core identity state. Normal management APIs never reveal existing values.

## Dependencies and verification

Pinned production dependencies: `jose 6.2.12`, `xml-crypto 6.3.2`, and `@xmldom/xmldom 0.9.12`. Billing, core, secrets, Hono and Zod are workspace peers. The private handler reuses the actual secrets package's secret-binding reader; the public API receives no KEK binding.

`tests/high-level/federation.test.ts` bundles the real API/protocol, private-broker and billing AdmissionController adapters, then runs them with D1 and Durable Objects in Miniflare/workerd. A bounded test IdP verifies actual PKCE and confidential-client authentication and issues cryptographically signed JWT/XML evidence. All **22 high-level scenarios and the focused TypeScript check passed on 5 October 2026**. They cover concurrent callbacks, tenant/issuer/audience/nonce/assurance failures, SAML wrapping/XXE/replay, explicit linking, SCIM lifecycle/filter/PATCH/idempotency, activation/group-removal races, personal-token authorization, credential revocation, last-owner protection, generation-fenced metadata receipts, broker operation retries, actual KEK rewrapping and ciphertext integrity. Review regressions additionally exercise paid seat/budget admission, SCIM/JIT/invitation contention, crashed and swept writer fencing, cross-organization credential preservation, cleared SSO mappings against a private repository, relationship ETags, replacement Groups, and primary/projection semantics. The test composition installs the required core hooks explicitly; production composition must install the same hooks.

Runtime validation uses `miniflare 5.20261001.0-alpha`/workerd with the supported V4-to-V5 configuration converter and native Node compatibility. The explicit CommonJS bootstrap uses `createRequire('/federation-worker.js')`; this runtime does not supply `import.meta.url`. External fetch uses `redirect:'manual'` and rejects every non-200 response: the pinned runtime rejects `redirect:'error'`, despite the current Request reference listing it. All JWT/XML verification and broker cryptography execute in workerd rather than a Node-only protocol mock.

The complete suite was revalidated on 5 October 2026 against the current `005_identity_safeguards.sql`, with `091_request_fingerprints.sql` and the API-only retained identity ring in the fixture: **22/22 passed, zero skipped, 5.83 seconds**. The fixture uses the single-primary `DB` authority; any explicit `IDENTITY_DB` fixture binding must also carry its matching `IDENTITY_CELL_ID` and `IDENTITY_SHARD_ID` descriptors. Product validation and authorization checks were not relaxed.

Focused commands from the repository root:

```sh
npx tsc --noEmit -p packages/federation/tsconfig.json
npx vitest run tests/high-level/federation.test.ts
```

Research checked against current docs/package releases on 4 October 2026:

- [jose verification and remote JWKS](https://github.com/panva/jose/tree/main/docs) — Worker-native Web Crypto, explicit issuer/audience/algorithm verification and bounded custom fetch.
- [xml-crypto verified references](https://github.com/node-saml/xml-crypto#verifying-xml-documents) — extract authenticated XML using `getSignedReferences()`, with pinned external trust.
- [xmldom](https://github.com/xmldom/xmldom) — pure-JavaScript XML parser, with fail-on-error parsing and explicit outer bounds.
- [Workers Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/) and [zlib](https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/) — supported native verification, signing and Redirect-binding compression.
- [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/) — atomic guarded membership, credential, replay and audit operations.
- [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644) and [RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) — SCIM protocol, schemas, mutation/error and pagination semantics.
