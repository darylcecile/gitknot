# Verification strategy

GitKnot uses behavior-level checks and end-to-end journeys. Tests execute real SQLite constraints and production SQL, real native Git/shell processes where relevant, and HTTP/browser user flows. Provider-only behavior is verified separately against the staging acceptance matrix in [capacity](capacity.md) and [operations](operations.md); local results do not establish provider acceptance.

`tests/support/database.ts` adapts Node's built-in SQLite to the D1 interface for deterministic control-plane tests. It executes each D1 batch in one transaction and rolls back the complete batch on a constraint error. It does not emulate read replicas or assert provider capacity. `tests/support/storage.ts` provides explicit test-only object storage and queue adapters, including checksum and conditional-write behavior; they are not selected by production code.

Node-hosted tests substitute provider base classes through `tests/support/cloudflare.ts`; services and storage must still be explicitly supplied. This does not emulate execution, Workflows durability, network isolation, or Container teardown. The local end-to-end stack uses real workerd and separately started native helpers.

The workerd suites also exercise production D1 constraints, separate identity/metadata databases, admission Durable Objects, encrypted-vault Web Crypto, cross-cell streaming, and physical repository movement. Movement includes real native Git plus local R2 copies and verifies funded duplication, immutable receipts, rollback, source cleanup, and post-cutover access. Fault injection withholds actual acknowledgments or changes authoritative state; it does not substitute successful business responses.

- `npm test`: high-level permission, collaboration, billing, workflow, runner, publication, and recovery scenarios.
- `npm run test:e2e`: real user journeys through the web/API and supported Git transport.
- `npm run typecheck`: all application, Worker, service, CLI, setup, and test TypeScript.
- `npm run build`: local, non-deploying build of the web application and Workers with the pinned Cloudflare CLI.
- `npm run check:config -- --all-layouts`: actual cf schema validation, binding/account boundaries, and direct/remote hosted layouts.

The three browser journeys provision their own verified local users and repositories, publish real source with stock Git, and exercise collaboration, revision conflict recovery, protected downloads, write-only secrets, workflow plans/cancellation, billing controls, and complete account exports. They also execute the UI's copied selected-job reproduction command with the compiled CLI and a real OCI isolation configuration, so a working Docker daemon is required. They use the built web application and real API with no network mocks or suite retries. The harness refuses occupied ports rather than reusing an unidentified stack. See [web verification](web.md#verification-and-integration-work) for setup and retained evidence.

The native Windows runner-isolation acceptance case requires Windows and `GITKNOT_WINDOWS_EXECUTION_CREDENTIAL_FILE`. Its platform skip on macOS/Linux is reported explicitly; it is not Windows acceptance evidence.

Tests should protect a meaningful user or operational invariant. Prefer a single scenario that exercises a complete authorization or lifecycle boundary over many tests that mirror helper implementations. Provider-only acceptance results must be recorded separately from local results, including the SDK/image versions, Cloudflare service limits, repository shape, and measured cleanup/cost envelope.
