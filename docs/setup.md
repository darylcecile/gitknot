# Setup

## Local prerequisites

- Node **24**, npm, and native Git. `.node-version` selects Node 24.
- Docker when building Container images or using real local Linux Sandboxes. The default local Git transport starts a native Git helper process.
- No Cloudflare credentials, account, zone access, or login are needed for local setup/build.

From the repository root:

```sh
node scripts/setup.ts
npm run dev
```

`npm run setup` runs the same bootstrap. Setup installs locked dependencies (`npm ci` when a lockfile exists), creates random private local keys and ignored cf project wrappers, applies numbered SQL migrations **locally only**, and provisions the finite local operating allocation below. It preserves existing keys and state while removing the legacy background identity-master copy. `--skip-install` reuses installed dependencies; `--skip-migrations` creates only tooling/key state and leaves funding untouched.

The API's required `IDENTITY_KEYS_JSON` ring is generated from the initial random local identity material. For an existing `SESSION_KEY`-only file, setup adds `current: "session-v1"` and `keys["session-v1"] = base64url(UTF8(existing SESSION_KEY))`. The original binding is a string; its UTF-8 bytes are the derivation material. An existing ring, its current version and all retained entries are preserved exactly. Invalid or missing existing identity material requires reconciliation rather than automatic replacement.

Local URLs:

| URL | Service |
| --- | --- |
| `http://localhost:5173` | React/Vite web UI |
| `http://localhost:8787` | API through the local multiworker router |
| `http://localhost:8788` | Stock HTTPS-style Git client transport over local HTTP |
| `127.0.0.1:8790` | Authenticated native Git helper |
| `127.0.0.1:8791` | Authenticated webhook DNS-pinning helper |

The Cloudflare Vite plugin runs the API, Git, consumers, execution controllers, vault, and private adapters in workerd. Services use real local D1/R2/DO/Queues/Workflows, persisted under **`.cloudflare/state/v3`**. The local Git adapter uses native Git and filesystem repositories under `.gitknot/git`; the production Artifacts binding is not silently emulated. Mail remains a local delivery simulation. The local stack uses direct local execution; the remote host's isolated HTTP tests exercise its separate trust boundary without contacting a deployed account. Hosted provider capacity/isolation needs the documented remote evidence.

```sh
npm run dev -- --containers
```

This selects real Docker-backed local Containers. It does not fabricate a measured production profile or provider teardown/isolation attestation. A source/profile/secret configuration error fails visibly. Local customer-owned runners use the same API protocol as deployed runners.

## Finite local operating allocation

Normal setup calls `infra/local/capacity.ts` after migrations, using the real billing allocator in isolated workerd against the same persisted local identity-primary D1. The default development pool is named `gitknot-development-cell-001-local-discretionary-initial-v1`: a **25 USD** operating cap, **1 USD** safety buffer, **1 USD** baseline commitment, and a **10 USD** slice for the configured `BILLING_PLATFORM_SLICE_ID`. The slice admits at most two instance slots and 2,000,000,000 stored bytes, with a fixed **30-day admission window**. Amounts are stored as exact nano-USD strings.

An explicitly configured, separate Git storage slice receives another bounded discretionary allocation with zero compute slots. An explicitly configured essential slice receives its own `essential` pool and the native-helper instance cap. Existing operator slices, including older `pool_e2e` allocations, are validated and preserved. Setup does not alter prices, account credits, spending, holds, admission epochs, stop controls or existing expiry dates. Hosted profiles remain operator-provided; this local cost allowance supplies no provider measurement.

```sh
node infra/local/capacity.ts --inspect
node infra/local/capacity.ts
```

The helper reports configured, stopped, expired or reconciliation-required allocations. Runtime admission remains authoritative. Repeating setup does not renew an old allocation or clear unknown holds. New local funding requires an explicit new generation and unused selected slice IDs; for example, persist a new `GITKNOT_DEVELOPMENT_BILLING_PLATFORM_SLICE_ID` in the local environment, then run `node infra/local/capacity.ts --generation november-v1`. Existing slices are never reparented, and retained work remains attached to its original financial journals until normal billing reconciliation or handoff completes.

Only development is supported. Staging/production funding remains an explicit operator operation. The browser fixture's capacity step reuses this helper; it contains no separate hidden funding SQL. The local native-process adapter continues to identify itself as local authority.

## Database changes

```sh
npm run db:migrate:local
npm run db:migrate:local -- --list
npm run db:migrate:local -- --database search
```

Core migrations are every numbered `migrations/*.sql` file, sorted numerically with deterministic filename ordering for equal prefixes, matching cf. Directory migrations are `infra/sql/directory/*.sql`. Search migrations are `ops/search/*.sql`. The tooling refuses virtual tables in core/directory schemas and commits each migration's content hash with that migration's D1 transaction. Add a new numbered migration instead of editing one already applied. No script path accepts remote migration flags. `IDENTITY_DB` is the account-primary authority: the initial home aliases the first core DB, and other cells reference that existing identity home rather than authorizing from copied membership rows. Local and provider configurations include its physical `IDENTITY_CELL_ID`/`IDENTITY_SHARD_ID` descriptors alongside the binding; both are required for core's logical authority selection.

`091_request_fingerprints.sql` belongs in every request-owning database: the identity home and every configured metadata/core shard. The local discovery applies it with the other core migrations. Destination databases need it before receiving moved request rows; `request_hash`, `fingerprint_version`, and `fingerprint_key_id` move unchanged.

For local inspection, use the same persistence root and **database ID**, not a binding name:

```sh
npx --no-install cf d1 raw <local-d1-uuid-from-setup> --local --persist-to .cloudflare/state --sql "SELECT COUNT(*) FROM repositories"
npx --no-install cf r2 objects list --local --persist-to .cloudflare/state --bucket-name gitknot-development-cell-001-blobs
```

Without `--persist-to`, cf resource commands use a shared user-wide state directory, not this dev server's data.

Setup prints each local UUID; `npm run infra:plan -- --mode development` also includes `local_database_ids`. Both migrations and bindings use `localDatabaseId()` from `infra/environment.ts`. Set `GITKNOT_LOCAL_STATE` to an alternate directory for an isolated verification run.

On the pinned cf beta, a local command can print its completed JSON result and then keep cleanup handles open. `infra/local-cf.ts` verifies the complete success receipt and terminates only that local CLI after a cleanup grace period; migration/read-route scripts use it. A direct cf inspection may need Ctrl-C after its JSON response. The adapter never accepts an incomplete/failed result or handles a remote command.

## Offline review and build

```sh
npm run typecheck
npm run check:config
npm run check:config -- --all-layouts
npm test
npx --no-install playwright install chromium
npm run test:e2e
npm run build
npm run check:config -- --build
npm run infra:plan -- --mode production --out .gitknot/infra/production-plan.json
```

`check:config` loads all three modes through Cloudflare's actual parser and checks source exports, isolated resource names, DO/Workflow linkage, account ownership, private routes, secret placement, queue retry/DLQ bounds, and Container hard caps. `--all-layouts` additionally checks isolated-account hosted and shared-identity metadata-cell configurations with explicit synthetic fixtures; it makes no provider request and supplies no execution measurement. `--build` compares the assembled bindings and ingress with the selected configuration. Trusted Build Output is `.cloudflare/output/v0`; remote hosted output has its own account root under `.cloudflare/accounts/execution/`. Native Dockerfile builds need a running Docker daemon and cached/downloadable base images. The browser suite also needs Docker: it executes the copied workflow-reproduction command using the actual CLI and OCI isolation fixture. `cf build` itself requires no provider credentials and performs no upload.

The generated `.gitknot/projects/*` manifests are local wrappers, not additional packages to install or commit. `.env.example` documents optional public operator settings. `.gitknot/local/keys.json` is generated with mode `0600`; keep it private and out of logs/commits.

### Export the actual OpenAPI contract

```sh
npm run openapi
```

This builds the actual API Worker through its generated production cf project, loads every runtime module from its Build Output manifest into isolated Miniflare v5/workerd with the authored Node compatibility flags, and requests `/openapi.json`. It uses ephemeral loopback ports and four public metadata bindings. No database, service or secret binding is supplied; attempted outbound requests fail the export. Authentication fixtures, native Git, migrations and the full development stack are unnecessary.

The output is `docs/api/openapi.json` with production origin `https://api.gitknot.com`. The exporter writes atomically, reads the full artifact back, checks unique operation IDs and all bundled JSON Schema references/anchors, and reports operation/path/schema/reference counts. An already built production API can be selected with `npm run openapi -- --build-output .`; CI uses that option after its full build. The required direct `miniflare@5.20261001.0-alpha` dependency matches the existing Vite runtime installation.

Explicit live export remains available with `--url http://localhost:8787` or `GITKNOT_API_URL`. As before, only the server metadata is normalized to the production origin; paths and schemas come from the actual API response. `--out <path>` selects another artifact destination.

## Prepare an operator-owned remote plan

The following are **later operator commands**, not part of setup. Supply a narrowly scoped token from a password manager and set the intended account explicitly; the tooling never starts login:

```sh
export GITKNOT_PRODUCTION_TRUST_ACCOUNT_ID=<existing-account-id>
export GITKNOT_PRODUCTION_TRUST_API_TOKEN=<operator-supplied-token>
npm run infra:plan -- --mode production --resolve --out .gitknot/infra/production-resolved.json
npm run infra:apply -- --mode production --plan .gitknot/infra/production-resolved.json
```

The first command with `--resolve` only reads Cloudflare. Review the exact accounts, resource names, existing `gitknot.com` zone, current DNS, quotas, and desired policy bodies. Adding `--apply` to the final command is a separate, explicit provider mutation. It still performs no Worker deployment or database migration.

### Select an isolated hosted execution account

Copy `infra/hosted-executor.example.json` to an operator-controlled file and set the executor ID, HTTPS origin, API callback origin, producer ID, and control-key binding for that mode. Staging's callback is `https://api.staging.gitknot.com`; production's is `https://api.gitknot.com`.

```sh
export GITKNOT_PRODUCTION_HOSTED_EXECUTOR_FILE=/private/path/production-hosted.json
export GITKNOT_PRODUCTION_TRUST_ACCOUNT_ID=<trusted-account-id>
export GITKNOT_PRODUCTION_EXECUTION_ACCOUNT_ID=<execution-account-id>
npm run infra:plan -- --mode production --out .gitknot/infra/production-hosted-plan.json
npm run build -- --mode production --save-images
```

The remote host's Custom Domain must be in a zone owned by the execution account. A delegated `execution.gitknot.com` child zone requires Cloudflare's Enterprise subdomain setup; the read-only plan verifies whichever execution-owned active zone contains the selected origin. It never attaches the trusted account's zone to an unrelated account's Worker.

Remote mode builds six trusted Workers and one narrow hosted Worker. The latter has no trusted D1, identity mirror, admission/vault/Git/API binding or general internal key. Its dedicated Workflow/DO/Container and ephemeral R2 bucket belong to the execution account. Retained outputs/sanitized snapshots return to trusted storage through attempt-scoped signed callbacks. `HOSTED_PROFILES_JSON` must describe the final measured remote image, built from `workers/hosted/Dockerfile`, not the different direct-hosted image.

Hosted control uses one dedicated transport key. API/background/execution receive it under the file's `key_binding`; the hosted Worker receives the same value as `HOSTED_CONTROL_KEY`. Infrastructure sets its public `HOSTED_CALLBACK_ORIGIN` to the exact API callback origin, which the host enforces during acceptance and every callback/replay. Optional `callback_key_binding` selects the trusted callback master, defaulting to `HOSTED_CALLBACK_KEY` when absent. Only trusted API/background/execution receive it.

Each dispatch persists its original callback key-binding name. Keep referenced control/callback names in `GITKNOT_<MODE>_HOSTED_PREVIOUS_KEY_BINDINGS` (at most eight retained names), with their original values. When moving from the unversioned default to a versioned callback key, retain `HOSTED_CALLBACK_KEY` there until old dispatches close. Publish new bindings before selecting them for new grants. Transport endpoint rotation also preserves each old dispatch's endpoint/control key until cleanup is verified. No callback master or platform key enters a job.

Remote snapshots upload one binary archive to the trusted API callback domain. Its zone's actual maximum request body must be at least the selected cache allowance plus 16 MiB, independently of the Workers Paid/subrequest settings. Confirm that setting and the maximum archive transfer during provider acceptance.

Changing an existing direct pool to remote requires draining and verifying its original attempts/snapshots first, or using a fresh cell/capacity slice. A source binding must not disappear while its cleanup still depends on it. The optional remote source's local checks are documented in `workers/hosted/README.md`.

### Platform secrets

Supply one mode-0600 JSON file per Worker containing only that Worker's required keys. Generate independent staging/production material. The broker receives `SECRETS_KEK_KEYRING_JSON` and `SECRETS_SERVICE_KEYS_JSON`; API/background/execution receive distinct vault-client keys. `SESSION_KEY` and the required `IDENTITY_KEYS_JSON` belong only to the API. Keyed request fingerprints require the explicit ring even when a legacy session key is present. The background mail consumer uses the authenticated private `API` service to prepare identity mail. `INTERNAL_SERVICE_KEY` is not a vault credential.

The `IDENTITY_KEYS_JSON` secret contains serialized JSON of this shape:

```json
{
  "current": "identity-v1",
  "keys": { "identity-v1": "<base64url encoding of at least 32 random bytes>" }
}
```

Version IDs are 1–32 ASCII letters, digits, `_` or `-`; encoded keys must fit the core ring's 43–128-character range. Every API cell within a mode uses the same version-to-key map from a protected shared source. Preserve all existing IDs/material when constructing a per-cell secret file. For a legacy transition, include `session-v1` using `Buffer.from(existingSessionKey, 'utf8').toString('base64url')` and keep it current initially. [Operations](operations.md#identity-key-versions-and-request-fingerprints) describes distribution, activation and retention.

The broker also receives `SECRETS_FEDERATION_SERVICE_KEYS_JSON` for the separate `federation.manage`/`federation.exchange`/`federation.sign` purpose catalog. Its API caller ID/key matches the API's vault-client identity, while the scope registry is separate. `GITKNOT_<MODE>_FEDERATION_TRUSTED_ORIGINS_FILE` supplies the operator's exact HTTPS IdP origin allowlist; an empty default grants no IdP egress. The integrated identity-contract marker is configured for core authentication/authorization and the broker. See [federation](federation.md).

```sh
npm run infra:apply -- --mode production --worker secrets --secrets-file /private/path/broker.json
```

This prints only the target and key names. An operator can add `--apply` after the corresponding Worker exists. The CLI reads a transient private request file, key values are not command arguments, state contains no secret values, and read-back verifies names only. Broker scope/rotation procedures are in [secrets](secrets.md).

For Workers Logpush, provide a separate mode-0600 `{ "access_key_id": "…", "secret_access_key": "…" }` file scoped only to the Logpush bucket:

```sh
npm run infra:apply -- --mode production --logpush-credentials /private/path/logpush.json
```

An explicit `--apply` is required to create the Logpush job. No provider token or destination secret is committed. See [operations](operations.md) for rollout evidence and [recovery](recovery.md) for restore procedures.

Remote mode has a separate execution-account Logpush bucket/job. Use the same command with `--account execution` and an execution-bucket-scoped credential file; this uses the execution account's operator API token and includes only the hosted Worker.
