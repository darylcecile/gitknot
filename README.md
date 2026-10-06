# GitKnot

An independent, API-first collaboration platform for people and agents, built on Cloudflare. GitKnot owns its accounts, authorization, HTTPS Git transport, collaboration, workflow semantics, and billing; users need only GitKnot credentials.

**Domains:** `gitknot.com`, `api.gitknot.com`, and `git.gitknot.com`. Staging uses separate `*.staging.gitknot.com` services and resources.

## Run and try GitKnot locally

### 1. Start the application

Install **Node.js 24**, npm, and Git. Start Docker Desktop if you want to run the browser tests, build Container images, or execute Docker-isolated workflows. The default web/API/native-Git development stack works without Docker or Cloudflare credentials.

From this repository's root:

```sh
npm run setup
npm run dev
```

`setup` installs the locked dependencies, creates private local keys, applies local database schemas, and initializes a finite development billing allocation. `dev` starts the web app, Workers, native Git service, vault and background processing. Keep that terminal running.

Use **http://localhost:5173** in your browser. The local dev/preview server redirects page navigation from `127.0.0.1` to `localhost`, keeping authentication, passkeys and callbacks on the configured origin. If an older tab shows “This browser origin is not authorized,” reopen it at the `localhost` URL.

| Open | Purpose |
| --- | --- |
| [localhost:5173](http://localhost:5173) | GitKnot web application |
| [localhost:8787/health/ready](http://localhost:8787/health/ready) | API readiness check |
| [localhost:8787/openapi.json](http://localhost:8787/openapi.json) | Running API specification |
| `http://localhost:8788` | Git remote origin |

### 2. Create and verify your account

1. Open [Create an account](http://localhost:5173/auth/signup) and sign up.
2. Local emails are captured by the development runtime. Open [Local Explorer → Email → Sending](http://localhost:8787/cdn-cgi/local/explorer/email/sending?worker=gitknot-development-cell-001-background), select the **background** Worker if necessary, open your verification message, and expand **Content**. Allow roughly 15 seconds for background processing.
3. Open the local verification URL from that message in your browser, click **Verify email**, then sign in to GitKnot.

The terminal also reports captured email details/local file paths. Use the development mailbox for password recovery and invitations too; local messages are simulated rather than sent to an external inbox.

### 3. Create a repository and push your first commit

In the web app, choose **New repository**, select your personal account, and create a private repository named `try-gitknot`. Wait for its provisioning operation to finish.

Open **Settings → Tokens**, select that repository by name, and grant `repositories.read`, `contents.read`, and `contents.push`. Save the token when it is shown.

In another terminal, choose a working directory outside this GitKnot checkout and replace `YOUR_USERNAME` below with your GitKnot username:

```sh
git clone http://localhost:8788/YOUR_USERNAME/try-gitknot.git
cd try-gitknot
git switch -c main
printf '# Trying GitKnot\n' > README.md
git add README.md
git commit -m "Initial commit"
git push -u origin main
```

When Git requests credentials, use `gitknot` as the username and your scoped token as the password. Git uses your existing commit-author configuration; configure `user.name` and `user.email` in this clone if needed. Refresh the repository page to browse the pushed file and history.

### 4. Explore the product

- **Issues:** create an issue, switch between rich text and Markdown, add a comment, and inspect document history.
- **Pull Requests:** push another branch, open a change, and try review threads and merge eligibility.
- **Workflows:** validate a definition and inspect its pinned plan. Executing jobs requires a configured runner/toolchain or hosted profile; see [workflows](docs/workflows.md) and [customer runners](docs/cli.md#customer-owned-runner).
- **Repository settings:** try scoped access, rules, write-only secrets, variables and webhooks.
- **Billing & usage:** inspect local usage, budgets and admission controls. Setup provides a $10 development capacity slice within a finite local operating pool; it creates no real charge. [Inspect or manage local capacity](docs/setup.md#finite-local-operating-allocation).
- **Accounts & teams → your account → Exports:** create a complete account archive, wait for verified coverage, and download the TAR.

### 5. Try the CLI against the same local account

Run these from the GitKnot source repository in a second terminal:

```sh
export GITKNOT_API_URL=http://localhost:8787
export GITKNOT_ALLOW_LOOPBACK_HTTP=1
npm run gitknot -- auth login
npm run gitknot -- repo list
npm run gitknot -- --help
```

`auth login` prompts for a GitKnot token without echoing it. Credentials are stored per API origin in your private CLI configuration, separately from production credentials. The CLI's [command guide](docs/cli.md) covers issues, workflows, runners, billing and verified exports.

To reuse that token through Git's host-scoped credential helper, build the CLI and configure it from the same terminal:

```sh
npm run build --workspace @gitknot/cli
npm run gitknot -- auth setup-git
npm run gitknot -- repo clone YOUR_USERNAME/try-gitknot ../try-gitknot-cli
```

The helper remembers the correct local Git origin, including port 8788, and keeps the token out of remote URLs and command arguments.

### Stop, restart, and update

Press **Ctrl-C** in the development terminal to stop the stack. Your data persists under `.cloudflare/state/v3`; native repositories and private local keys live under `.gitknot/`.

After pulling code changes, stop the server, rerun `npm run setup`, then `npm run dev`. Setup preserves existing data, keys, spending, reservations and stop controls. If the operating allocation is expired or stopped, inspect it with `node infra/local/capacity.ts --inspect`; rerunning setup does not reset it.

The stack uses ports **5173, 8787, 8788, 8790, 8791 and 8792**. Stop an existing GitKnot dev stack before starting another or running the isolated browser suite. See [setup](docs/setup.md) for alternate data directories and detailed configuration.

### Run the complete browser walkthrough automatically

With Docker running and the development stack stopped:

```sh
npx --no-install playwright install chromium
npm run test:e2e
```

This creates separate verified test users and repositories, exercises the real API and native Git, runs a Docker-isolated CLI reproduction, and checks account archives. Fixture data and reports are stored in `.gitknot/e2e/`; the harness shuts down its services when the run ends.

## Application

- Accounts, organizations, teams, granular roles, scoped credentials, passkeys/MFA, and enterprise federation.
- Public, private, internal, and unlisted repositories; controlled HTTPS Git publication, LFS, browsing, imports, forks, and recoverable lifecycle operations.
- Issues, versioned pull requests and reviews, discussions, actionable notifications, search coverage, and coordinated task workspaces.
- Declarative workflows, immutable verification plans, hosted execution, customer-owned runners, environments, and artifact promotion.
- An encrypted tenant secret vault, scoped variables, exact usage accounting, budget reservations, invoices, and storage limits.
- A shared REST API, web application, and `gitknot` CLI; durable events, signed webhooks, complete exports, and recovery tooling.

Native SSH is the later transport extension. HTTPS publication and policy form the common Git foundation.

## Development commands

```sh
npm run typecheck
npm run check:config -- --all-layouts
npm test
npm run test:e2e
npm run build
npm run openapi
npm run infra:plan
npm run gitknot -- --help
```

The high-level suite exercises application/permission boundaries, native Git and shell behavior, transactions, workflow/cost controls, and recovery. Browser end-to-end tests cover user journeys. See [testing](docs/testing.md) for the distinction between local verification and provider acceptance.

## Structure

| Path | Responsibility |
| --- | --- |
| `apps/api` | Versioned API, product services, and static asset entrypoint |
| `apps/web` | React web application |
| `packages/core` | Shared identity/policy interfaces, HTTP contracts, transactions, routing, and events |
| `packages/workflows` | Portable workflow compiler and immutable plans |
| `packages/cli`, `packages/runner` | GitKnot CLI and outbound customer-owned runner |
| `packages/git`, `services/git`, `workers/git` | Storage adapter, trusted native Git processing, and HTTPS gateway |
| `packages/execution`, `workers/execution` | Hosted execution, leases, cancellation, and cleanup |
| `packages/billing`, `packages/secrets`, `workers/secrets` | Ledger/admission and private encrypted vault |
| `workers/background` | Durable orchestration, events, deliveries, indexes, and lifecycle operations |
| `infra`, `scripts`, `migrations` | Typed Cloudflare configuration, setup, schema, and operations |
| `tests` | High-level and end-to-end verification |

## Documentation

- [Product and architecture proposal](proposal.md)
- [API conventions](docs/api-conventions.md)
- [Workflow language](docs/workflows.md) and [CLI](docs/cli.md)
- [Git transport and publication](docs/git.md)
- [Billing and spending controls](docs/billing.md)
- [Complete account exports](docs/account-exports.md)
- [Secrets](docs/secrets.md) and [federation](docs/federation.md)
- [Infrastructure](docs/infrastructure.md), [operations](docs/operations.md), and [recovery](docs/recovery.md)
- [Security invariants](docs/security-invariants.md) and [testing](docs/testing.md)
- [Implementation review and verification results](docs/verification.md)

The Cloudflare CLI and CI SDK are pinned because their current interfaces are in beta. Rollout uses the configured service limits and recorded staging acceptance results, including Artifacts atomic publication, hosted cleanup, egress enforcement, and the tested execution cost envelope.
