import { COMMANDS } from './commands.ts';

const CUSTOM: Record<string, Array<[string, string]>> = {
  auth: [
    ['login [--with-token]', 'Authenticate with a hidden token prompt or stdin.'],
    ['login --username LOGIN [--password-stdin]', 'Authenticate a human session, including second-factor verification.'],
    ['status', 'Inspect current credential metadata without its value.'],
    ['logout [--local-only]', 'Revoke the current credential and remove local authentication.'],
    ['setup-git', 'Configure the token-free Git credential helper.'],
  ],
  repo: [['clone OWNER/NAME [DIRECTORY]', 'Clone with standard GitKnot HTTPS Git.']],
  workflow: [
    ['validate [NAME|FILE] [--modules FILE]', 'Validate YAML, graph, permissions, typed modules, and references.'],
    ['plan [NAME|FILE] --event FILE --toolchains FILE', 'Compile an immutable, pinned execution manifest.'],
    ['run NAME --repo REPO [--watch]', 'Start a remote workflow run.'],
    ['run [NAME|FILE] --local --toolchains FILE --isolation FILE', 'Execute the compiled graph against exact local tools.'],
    ['reproduce RUN_ID --job JOB --isolation FILE', 'Retrieve the original plan and checksummed inputs, then execute locally.'],
    ['module-digest FILE', 'Compute the canonical digest for a versioned module.'],
    ['toolchain inspect [--name ALIAS] [--tools node,npm,git]', 'Inspect exact host tools for an explicit toolchain lock.'],
  ],
  runner: [
    ['register --toolchains FILE --isolation FILE [--name NAME] [--disposable]', 'Enroll with an enforced supervisor/job credential boundary.'],
    ['start [--config FILE] [--once]', 'Run the outbound-only customer-owned worker.'],
    ['status [--config FILE]', 'Inspect local machine registration without its credential.'],
    ['rotate [--config FILE]', 'Rotate and atomically save the machine credential.'],
    ['recover [--config FILE]', 'Recover the exact durable enrollment/rotation exchange after a lost response.'],
  ],
  export: [
    ['create --account ACCOUNT_ID [--watch]', 'Create a complete account export; retain --idempotency-key for uncertain retries.'],
    ['list --account ACCOUNT_ID [--paginate]', 'List your account exports and their verified coverage.'],
    ['show EXPORT_ID --account ACCOUNT_ID [--include]', 'Read account export progress and its strong resource ETag.'],
    ['watch EXPORT_ID --account ACCOUNT_ID', 'Wait for verified completion or deletion; fail on incomplete/failed/expired capture.'],
    ['download EXPORT_ID --account ACCOUNT_ID --output FILE [--watch]', 'Download only complete coverage and verify TAR type, ETag, byte count and SHA-256.'],
    ['delete EXPORT_ID --account ACCOUNT_ID --if-match ETAG [--watch]', 'Request cleanup and optionally wait for verified deletion.'],
  ],
  secret: [['list|view|versions|delete [NAME]', 'Manage write-only secret metadata in a selected scope.'], ['set NAME --value-stdin', 'Create/rotate a secret without putting its value in arguments.']],
  variable: [['list|view|versions|delete [NAME]', 'Manage readable configuration in a selected scope.'], ['set NAME --value VALUE', 'Create/update a variable.']],
  search: [['QUERY [--repo REPO] [--paginate]', 'Search with the API’s visible freshness and coverage metadata.'], ['code QUERY --complete --input FILE', 'Start a complete revision-pinned code scan.'], ['scan|results SCAN_ID', 'Read complete-scan progress or paginated results.']],
};

export function help(group?: string): string {
  if (group === 'api') return `gitknot api [METHOD] /v1/PATH [options]\n\nUse the complete GitKnot REST contract, including binary uploads/downloads.\n\n  --input FILE|-         JSON request body (stdin with -)\n  --field key=value      Typed JSON field; nested keys use dots\n  --raw-field key=value  Literal string field\n  --query key=value      Query parameter (repeatable)\n  --header 'Name: value' Additional request header\n  --if-match '"7"'       Strong resource ETag\n  --idempotency-key KEY  Reuse for an uncertain creation request\n  --paginate            Emit every cursor page as JSON Lines\n  --include             Include status and safe response headers\n  --binary --input FILE  Stream a binary upload\n  --output FILE         Stream a response to a file\n  --sha256 DIGEST --size BYTES  Verify an exact download\n  --watch               Wait for an operation/run and fail on unsuccessful outcome\n  --timeout SECONDS     Request/watch deadline\n  --api-url ORIGIN       Default: https://api.gitknot.com\n\nExample: gitknot api PATCH /v1/repos/r_catalog/issues/issue_123 --if-match '"7"' --field state=closed\n`;
  if (group) {
    const lines = [...(CUSTOM[group] ?? []).map(([name, summary]) => `  ${group} ${name}\n      ${summary}`), ...COMMANDS.filter((command) => command.name.startsWith(`${group} `)).map((command) => `  ${command.name}${(command.parameters ?? []).map((parameter) => ` ${parameter.toUpperCase()}`).join('')}\n      ${command.summary}`)];
    if (!lines.length) return '';
    return `GitKnot ${group}\n\n${lines.join('\n')}\n\nUse --repo REPO_ID or --account ACCOUNT_ID for scoped commands.\nSemantic API commands also accept --input, --field, --query, --if-match, --paginate, and --watch.\n`;
  }
  return `GitKnot 0.1.0 — software collaboration and portable workflows\n\nUsage: gitknot <command> [options]\n\n  auth         GitKnot account/session and scoped token authentication\n  repo         Repositories, HTTPS Git, refs, rules, and lifecycle\n  issue, pr    Issues, pull requests, reviews, and protected merging\n  search       Search freshness, coverage, and complete code scans\n  workflow     Validate, plan, run locally/remotely, and reproduce\n  run          Jobs, attempts, cancellation, logs, outputs, and approvals\n  runner       Pools, enrollment, machine credentials, and execution\n  secret       Write-only secret management\n  variable     Readable scoped configuration\n  billing      Usage, budgets, invoices, subscriptions, and credits\n  export       Versioned, complete archives and restoration\n  org, team, user, discussion, task, environment, token, label, milestone\n  inbox, feed, webhook\n  api          Every /v1 API operation, pagination, and binary transfer\n\nGlobal options:\n  --api-url ORIGIN     Default: https://api.gitknot.com\n  --json               Compact machine-readable output\n  --help               Command reference\n  --version            Installed version\n\nStart: gitknot auth login\nHelp:  gitknot workflow --help\nDocs:  https://gitknot.com/docs/cli\n`;
}
