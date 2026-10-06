import { RunnerError } from '../../runner/src/index.ts';
import { isSafeRelativePath } from '../../workflows/src/index.ts';
import { API_FLAGS, sendApi } from './api.ts';
import { checkFlags, flag, identifier, type Arguments } from './args.ts';
import type { CliIO } from './io.ts';
import { repositoryId } from './config.ts';

export interface Command {
  name: string;
  method: string;
  path: string;
  parameters?: string[];
  parameter_fields?: Record<string, string>;
  fields?: Record<string, string>;
  body?: Record<string, unknown>;
  summary: string;
  watch?: boolean;
}

const repo = '/v1/repos/{repo}';
const issues = `${repo}/issues`;
const pulls = `${repo}/pulls`;
const account = '/v1/accounts/{account}';
const titleFields = { title: 'title', body: 'markdown' };

export const COMMANDS: Command[] = [
  { name: 'repo list', method: 'GET', path: '/v1/repos', fields: { owner: 'owner_id', visibility: 'visibility' }, summary: 'List authorized repositories.' },
  { name: 'repo create', method: 'POST', path: '/v1/repos', fields: { name: 'name', owner: 'owner_id', description: 'description', visibility: 'visibility' }, summary: 'Create a repository and its provisioning operation.' },
  { name: 'repo view', method: 'GET', path: repo, parameters: ['repo'], summary: 'Read repository metadata and its revision.' },
  { name: 'repo edit', method: 'PATCH', path: repo, parameters: ['repo'], fields: { name: 'name', description: 'description', visibility: 'visibility', 'default-branch': 'default_branch' }, summary: 'Edit repository metadata with If-Match.' },
  { name: 'repo delete', method: 'DELETE', path: repo, parameters: ['repo'], summary: 'Delete a repository through its recovery lifecycle.' },
  { name: 'repo archive', method: 'POST', path: `${repo}/archive`, parameters: ['repo'], summary: 'Archive a repository.' },
  { name: 'repo unarchive', method: 'DELETE', path: `${repo}/archive`, parameters: ['repo'], summary: 'Reactivate an archived repository.' },
  { name: 'repo restore', method: 'POST', path: `${repo}/restore`, parameters: ['repo'], summary: 'Restore a repository in its recovery window.' },
  { name: 'repo import', method: 'POST', path: '/v1/repos', fields: { name: 'name', owner: 'owner_id', source: 'import.source_url', visibility: 'visibility', secret: 'import.source_secret_id' }, summary: 'Import an HTTPS Git repository through a visible operation.' },
  { name: 'repo fork', method: 'POST', path: '/v1/repos', parameters: ['source_repo'], parameter_fields: { source_repo: 'fork_source_id' }, fields: { owner: 'owner_id', name: 'name', visibility: 'visibility' }, summary: 'Create an authorized fork.' },
  { name: 'repo transfer', method: 'POST', path: `${repo}/transfers`, parameters: ['repo'], fields: { to: 'destination_owner_id' }, summary: 'Start an ownership transfer.' },
  { name: 'repo refs', method: 'GET', path: `${repo}/refs`, parameters: ['repo'], summary: 'List repository refs.' },
  { name: 'repo commits', method: 'GET', path: `${repo}/commits`, parameters: ['repo'], fields: { ref: 'ref' }, summary: 'Read commit history.' },
  { name: 'repo tree', method: 'GET', path: `${repo}/trees/{id}`, parameters: ['repo', 'id'], summary: 'Read a pinned tree.' },
  { name: 'repo file', method: 'GET', path: `${repo}/raw`, parameters: ['repo', 'path'], parameter_fields: { path: 'path' }, fields: { ref: 'ref' }, summary: 'Read a revision-scoped repository file.' },
  { name: 'repo compare', method: 'GET', path: `${repo}/compare`, parameters: ['repo'], fields: { base: 'base', head: 'ref' }, summary: 'Compare exact repository revisions.' },
  { name: 'repo collaborators', method: 'GET', path: `${repo}/collaborators`, parameters: ['repo'], summary: 'List repository collaborators.' },
  { name: 'repo rules', method: 'GET', path: `${repo}/rules`, parameters: ['repo'], summary: 'Read repository rules.' },
  { name: 'repo permissions', method: 'POST', path: `${repo}/permissions/explain`, parameters: ['repo'], fields: { capability: 'capability', ref: 'ref' }, summary: 'Explain a concrete capability decision.' },
  { name: 'issue list', method: 'GET', path: issues, fields: { state: 'state', search: 'q', assignee: 'assignee', label: 'label' }, summary: 'List and filter issues.' },
  { name: 'issue view', method: 'GET', path: `${issues}/{id}`, parameters: ['id'], summary: 'Read an issue.' },
  { name: 'issue create', method: 'POST', path: issues, fields: { ...titleFields, template: 'template_id', priority: 'priority' }, summary: 'Create an issue from Markdown or a template.' },
  { name: 'issue edit', method: 'PATCH', path: `${issues}/{id}`, parameters: ['id'], fields: { ...titleFields, state: 'state', priority: 'priority', status: 'status_id', milestone: 'milestone_id' }, summary: 'Edit an issue with If-Match.' },
  { name: 'issue close', method: 'PATCH', path: `${issues}/{id}`, parameters: ['id'], body: { state: 'closed' }, summary: 'Close an issue.' },
  { name: 'issue reopen', method: 'PATCH', path: `${issues}/{id}`, parameters: ['id'], body: { state: 'open' }, summary: 'Reopen an issue.' },
  { name: 'issue comment', method: 'POST', path: `${issues}/{id}/comments`, parameters: ['id'], fields: { body: 'markdown' }, summary: 'Add a Markdown comment.' },
  { name: 'issue comments', method: 'GET', path: `${issues}/{id}/comments`, parameters: ['id'], summary: 'List issue comments.' },
  { name: 'issue assign', method: 'PUT', path: `${issues}/{id}/assignees`, parameters: ['id'], summary: 'Replace issue assignees from JSON input.' },
  { name: 'issue labels', method: 'PUT', path: `${issues}/{id}/labels`, parameters: ['id'], summary: 'Replace issue labels from JSON input.' },
  { name: 'issue dependencies', method: 'GET', path: `${issues}/{id}/dependencies`, parameters: ['id'], summary: 'Read issue dependencies.' },
  { name: 'issue link', method: 'POST', path: `${issues}/{id}/pulls`, parameters: ['id'], summary: 'Link a proposed change to an issue.' },
  { name: 'pr list', method: 'GET', path: pulls, fields: { state: 'state', search: 'q' }, summary: 'List pull requests.' },
  { name: 'pr view', method: 'GET', path: `${pulls}/{id}`, parameters: ['id'], summary: 'Read a pull request and patch state.' },
  { name: 'pr create', method: 'POST', path: pulls, fields: { ...titleFields, 'base-ref': 'base_ref', 'head-ref': 'head_ref', 'base-oid': 'base_oid', 'head-oid': 'head_oid', 'head-repo': 'head_repo_id', draft: 'draft' }, summary: 'Open a revision-pinned pull request.' },
  { name: 'pr edit', method: 'PATCH', path: `${pulls}/{id}`, parameters: ['id'], fields: { ...titleFields, state: 'state' }, summary: 'Edit a pull request with If-Match.' },
  { name: 'pr close', method: 'PATCH', path: `${pulls}/{id}`, parameters: ['id'], body: { state: 'closed' }, summary: 'Close a pull request.' },
  { name: 'pr reopen', method: 'PATCH', path: `${pulls}/{id}`, parameters: ['id'], body: { state: 'open' }, summary: 'Reopen a pull request.' },
  { name: 'pr comment', method: 'POST', path: `${pulls}/{id}/comments`, parameters: ['id'], fields: { body: 'markdown' }, summary: 'Comment on a pull request.' },
  { name: 'pr review', method: 'POST', path: `${pulls}/{id}/reviews`, parameters: ['id'], fields: { body: 'markdown', decision: 'decision', patch: 'patch_id' }, summary: 'Submit a patch-bound review.' },
  { name: 'pr reviews', method: 'GET', path: `${pulls}/{id}/reviews`, parameters: ['id'], summary: 'List patch-bound reviews.' },
  { name: 'pr review-request', method: 'POST', path: `${pulls}/{id}/review-requests`, parameters: ['id'], summary: 'Request reviewers from JSON input.' },
  { name: 'pr threads', method: 'GET', path: `${pulls}/{id}/threads`, parameters: ['id'], summary: 'List revision-anchored review threads.' },
  { name: 'pr patches', method: 'GET', path: `${pulls}/{id}/patches`, parameters: ['id'], summary: 'List immutable patch versions.' },
  { name: 'pr diff', method: 'GET', path: `${pulls}/{id}/diff`, parameters: ['id'], summary: 'Read a native Git diff.' },
  { name: 'pr compare', method: 'GET', path: `${pulls}/{id}/compare`, parameters: ['id'], summary: 'Compare patch versions and review impact.' },
  { name: 'pr merge', method: 'POST', path: `${pulls}/{id}/merge-queue`, parameters: ['id'], fields: { strategy: 'strategy' }, summary: 'Queue protected candidate verification and Git publication.' },
  { name: 'pr eligibility', method: 'GET', path: `${pulls}/{id}/merge-eligibility`, parameters: ['id'], summary: 'Explain merge requirements.' },
  { name: 'pr queue', method: 'POST', path: `${pulls}/{id}/merge-queue`, parameters: ['id'], fields: { strategy: 'strategy' }, summary: 'Queue the actual merge candidate for verification.' },
  { name: 'pr dequeue', method: 'DELETE', path: `${pulls}/{id}/merge-queue/{queue_id}`, parameters: ['id', 'queue_id'], summary: 'Cancel a queued merge entry.' },
  { name: 'pr restack', method: 'POST', path: `${pulls}/{id}/restack`, parameters: ['id'], summary: 'Restack dependent changes with a durable operation.' },
  { name: 'pr dependencies', method: 'GET', path: `${pulls}/{id}/dependencies`, parameters: ['id'], summary: 'Read pull-request dependencies.' },
  { name: 'workflow list', method: 'GET', path: `${repo}/workflows`, summary: 'List trusted workflow definitions.' },
  { name: 'workflow view', method: 'GET', path: `${repo}/workflows/{id}`, parameters: ['id'], summary: 'Read a registered workflow and its approved version.' },
  { name: 'workflow create', method: 'POST', path: `${repo}/workflows`, fields: { path: 'path', revision: 'source_commit' }, summary: 'Register a trusted workflow definition.' },
  { name: 'workflow edit', method: 'PUT', path: `${repo}/workflows/{id}`, parameters: ['id'], fields: { path: 'path', revision: 'source_commit' }, summary: 'Approve a new immutable workflow version.' },
  { name: 'workflow delete', method: 'DELETE', path: `${repo}/workflows/{id}`, parameters: ['id'], summary: 'Disable future workflow runs.' },
  { name: 'workflow versions', method: 'GET', path: `${repo}/workflows/{id}/versions`, parameters: ['id'], summary: 'List immutable workflow versions.' },
  { name: 'workflow policy', method: 'GET', path: `${repo}/workflow-policy`, summary: 'Read trusted toolchains, modules, permissions, and egress policy.' },
  { name: 'workflow policy-set', method: 'PUT', path: `${repo}/workflow-policy`, summary: 'Set trusted workflow execution policy with If-Match.' },
  { name: 'workflow operation', method: 'GET', path: '/v1/workflow-operations/{id}', parameters: ['id'], summary: 'Read a durable workflow operation at its current repository placement.' },
  { name: 'workflow operation-watch', method: 'GET', path: '/v1/workflow-operations/{id}', parameters: ['id'], watch: true, summary: 'Wait for a durable workflow operation to finish.' },
  { name: 'run list', method: 'GET', path: `${repo}/runs`, fields: { workflow: 'workflow_id', status: 'status', commit: 'commit' }, summary: 'List workflow runs.' },
  { name: 'run view', method: 'GET', path: '/v1/runs/{id}', parameters: ['id'], summary: 'Read a workflow run.' },
  { name: 'run watch', method: 'GET', path: '/v1/runs/{id}', parameters: ['id'], watch: true, summary: 'Wait for a terminal outcome; fail on unsuccessful verification.' },
  { name: 'run cancel', method: 'POST', path: '/v1/runs/{id}/cancel', parameters: ['id'], summary: 'Cancel admission, credentials, and active process groups.' },
  { name: 'run rerun', method: 'POST', path: '/v1/runs/{id}/rerun', parameters: ['id'], summary: 'Rerun selected jobs and affected dependents; --field jobs=["test"].' },
  { name: 'run jobs', method: 'GET', path: '/v1/runs/{id}/jobs', parameters: ['id'], summary: 'Read explicit job outcomes.' },
  { name: 'run attempts', method: 'GET', path: '/v1/runs/{id}/attempts', parameters: ['id'], summary: 'List immutable attempts.' },
  { name: 'run logs', method: 'GET', path: '/v1/runs/{id}/logs', parameters: ['id'], fields: { job: 'job_id', attempt: 'attempt_id' }, summary: 'Read full run logs with cursor pagination.' },
  { name: 'run outputs', method: 'GET', path: '/v1/runs/{id}/outputs', parameters: ['id'], summary: 'List checksummed outputs and reports.' },
  { name: 'run manifest', method: 'GET', path: '/v1/runs/{id}/manifest', parameters: ['id'], summary: 'Download the immutable portable manifest.' },
  { name: 'run approve', method: 'POST', path: '/v1/runs/{id}/approvals', parameters: ['id'], summary: 'Approve a specific artifact/commit/plan/environment binding.' },
  { name: 'billing view', method: 'GET', path: `${account}/billing`, summary: 'Read plan, usage, reservations, and payer.' },
  ...['usage', 'budgets', 'invoices', 'statements', 'subscription', 'credits'].map((resource): Command => ({ name: `billing ${resource}`, method: 'GET', path: `${account}/${resource}`, summary: `Read account ${resource}.` })),
  { name: 'billing budget-create', method: 'POST', path: `${account}/budgets`, summary: 'Create a hard cap or alert budget using exact amounts.' },
  { name: 'billing budget-edit', method: 'PATCH', path: `${account}/budgets/{id}`, parameters: ['id'], summary: 'Edit a budget with If-Match.' },
  { name: 'billing budget', method: 'GET', path: `${account}/budgets/{id}`, parameters: ['id'], summary: 'Read a hard cap and its outstanding commitments.' },
  { name: 'billing plans', method: 'GET', path: `${account}/billing/plans`, summary: 'Read versioned plan prices.' },
  { name: 'billing statement-download', method: 'GET', path: `${account}/statements/{id}/download`, parameters: ['id'], summary: 'Download an exact-unit account statement using --output.' },
  { name: 'billing subscription-edit', method: 'PUT', path: `${account}/subscription`, summary: 'Change subscription through the authorized billing API.' },
  { name: 'export create', method: 'POST', path: `${repo}/exports`, summary: 'Create a complete, versioned repository export.' },
  { name: 'export view', method: 'GET', path: `${repo}/exports/{id}`, parameters: ['id'], summary: 'Inspect export progress and its checksum.' },
  { name: 'export watch', method: 'GET', path: '/v1/operations/{id}', parameters: ['id'], watch: true, summary: 'Wait for a durable export operation.' },
  { name: 'export download', method: 'GET', path: `${repo}/exports/{id}/download`, parameters: ['id'], summary: 'Download a completed archive using --output.' },
  { name: 'export restore', method: 'POST', path: `${repo}/restore`, parameters: ['archive'], parameter_fields: { archive: 'archive_id' }, summary: 'Restore a retained repository from a versioned archive.' },
  { name: 'runner list', method: 'GET', path: '/v1/runner-pools/{pool}/runners', summary: 'List enrolled runner machines using --pool.' },
  { name: 'runner view', method: 'GET', path: '/v1/runners/{id}', parameters: ['id'], summary: 'Read runner status and capabilities.' },
  { name: 'runner revoke', method: 'PATCH', path: '/v1/runners/{id}', parameters: ['id'], body: { state: 'revoked' }, summary: 'Revoke a machine and fence its attempts.' },
  { name: 'runner enroll', method: 'POST', path: '/v1/runner-enrollments', fields: { pool: 'pool_id' }, summary: 'Issue a one-time, pool-scoped enrollment token.' },
  { name: 'runner pool list', method: 'GET', path: '/v1/runner-pools', fields: { account: 'account_id', repo: 'repo_id' }, summary: 'List authorized runner pools with --repo or --account.' },
  { name: 'runner pool create', method: 'POST', path: '/v1/runner-pools', fields: { account: 'account_id', repo: 'repo_id', name: 'name', trust: 'trust', isolation: 'isolation' }, summary: 'Create a scoped runner pool with explicit trust constraints.' },
  { name: 'runner pool view', method: 'GET', path: '/v1/runner-pools/{id}', parameters: ['id'], summary: 'Read pool configuration.' },
  { name: 'runner pool edit', method: 'PATCH', path: '/v1/runner-pools/{id}', parameters: ['id'], summary: 'Edit pool scope and capabilities.' },
  { name: 'runner pool delete', method: 'PATCH', path: '/v1/runner-pools/{id}', parameters: ['id'], body: { state: 'disabled' }, summary: 'Disable a runner pool.' },
  { name: 'api capabilities', method: 'GET', path: '/v1/api-capabilities', summary: 'Discover the complete API and capability model.' },
];

function crud(name: string, path: string, summary: string): Command[] {
  return [
    { name: `${name} list`, method: 'GET', path, summary: `List ${summary}.` },
    { name: `${name} view`, method: 'GET', path: `${path}/{id}`, parameters: ['id'], summary: `Read ${summary}.` },
    { name: `${name} create`, method: 'POST', path, summary: `Create ${summary} from JSON.` },
    { name: `${name} edit`, method: 'PATCH', path: `${path}/{id}`, parameters: ['id'], summary: `Edit ${summary} with If-Match.` },
    { name: `${name} delete`, method: 'DELETE', path: `${path}/{id}`, parameters: ['id'], summary: `Delete ${summary} with If-Match.` },
  ];
}

COMMANDS.push(
  ...crud('org', '/v1/orgs', 'organizations'), ...crud('team', '/v1/orgs/{account}/teams', 'teams'),
  ...crud('discussion', `${repo}/discussions`, 'discussions'), ...crud('task', `${repo}/tasks`, 'tasks'),
  ...crud('environment', `${repo}/environments`, 'protected environments').map((command) => command.name === 'environment edit' ? { ...command, method: 'PUT' } : command), ...crud('token', '/v1/tokens', 'scoped credentials'),
  ...crud('label', `${repo}/labels`, 'labels'), ...crud('milestone', `${repo}/milestones`, 'milestones'),
  { name: 'inbox list', method: 'GET', path: '/v1/inbox', summary: 'Read outstanding decisions and notifications.' },
  { name: 'inbox complete', method: 'PATCH', path: '/v1/inbox/{id}', parameters: ['id'], body: { state: 'completed' }, summary: 'Acknowledge an inbox item after resolving its source action.' },
  { name: 'feed list', method: 'GET', path: '/v1/feed', summary: 'Read your authorized activity feed.' },
  { name: 'webhook list', method: 'GET', path: `${repo}/webhooks`, summary: 'List repository webhooks.' },
  { name: 'webhook create', method: 'POST', path: `${repo}/webhooks`, summary: 'Create a webhook from JSON input.' },
  { name: 'webhook view', method: 'GET', path: '/v1/webhooks/{id}', parameters: ['id'], summary: 'Read a webhook.' },
  { name: 'webhook edit', method: 'PATCH', path: '/v1/webhooks/{id}', parameters: ['id'], summary: 'Edit a webhook.' },
  { name: 'webhook delete', method: 'DELETE', path: '/v1/webhooks/{id}', parameters: ['id'], summary: 'Revoke a webhook.' },
  { name: 'webhook deliveries', method: 'GET', path: '/v1/webhooks/{id}/deliveries', parameters: ['id'], summary: 'Read webhook delivery attempts.' },
  { name: 'webhook redeliver', method: 'POST', path: '/v1/deliveries/{id}/redeliver', parameters: ['id'], summary: 'Replay the same event with a new delivery attempt.' },
  { name: 'user view', method: 'GET', path: '/v1/users/{id}', parameters: ['id'], summary: 'Read a visible profile.' },
  { name: 'user me', method: 'GET', path: '/v1/me', summary: 'Read your profile.' },
  { name: 'user edit', method: 'PATCH', path: '/v1/me', summary: 'Edit your profile and privacy.' },
);

export function matchCommand(words: string[]): Command | undefined {
  return [...COMMANDS].sort((a, b) => b.name.split(' ').length - a.name.split(' ').length).find((command) => command.name.split(' ').every((part, index) => words[index] === part));
}

function scopeDefaults(command: Command, args: Arguments, values: Record<string, string | undefined>): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const name of ['repo', 'account']) {
    const field = command.fields?.[name], value = values[name];
    if (!field || !value || flag(args, name)) continue;
    if (command.name === 'runner pool list' && name === 'account' && values.repo) continue;
    defaults[field] = value;
  }
  return defaults;
}

async function resolveFieldScopes(command: Command, args: Arguments, values: Record<string, string | undefined>): Promise<Arguments> {
  const flags = new Map(args.flags);
  for (const [name, field] of Object.entries(command.fields ?? {})) {
    if (field !== 'repo_id' && field !== 'head_repo_id') continue;
    const value = flag(args, name);
    if (value) flags.set(name, [name === 'repo' ? values.repo! : (await repositoryId(args, value))!]);
  }
  return { ...args, flags };
}

export async function semanticCommand(command: Command, args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  checkFlags(args, [...API_FLAGS, 'repo', 'account', 'environment', 'pool', ...Object.keys(command.fields ?? {})]);
  const words = args.words.slice(command.name.split(' ').length);
  const parameters = command.parameters ?? [];
  if (words.length > parameters.length) throw new RunnerError('usage', 'Too many positional arguments.');
  const values: Record<string, string | undefined> = { repo: flag(args, 'repo') ?? process.env.GITKNOT_REPO, account: flag(args, 'account') ?? process.env.GITKNOT_ACCOUNT, environment: flag(args, 'environment'), pool: flag(args, 'pool') };
  let position = 0;
  for (const name of parameters) {
    if (['repo', 'account', 'pool', 'environment'].includes(name) && flag(args, name)) continue;
    if (words[position]) values[name] = words[position++];
  }
  if (position !== words.length) throw new RunnerError('usage', 'Positional arguments conflict with an explicitly selected resource scope.');
  // Explicit account listing takes precedence over an ambient repository scope.
  if (command.name === 'runner pool list' && flag(args, 'account') && !flag(args, 'repo')) values.repo = undefined;
  if (command.path.includes('{repo}') || command.fields?.repo) values.repo = await repositoryId(args, values.repo);
  if (values.source_repo) values.source_repo = await repositoryId(args, values.source_repo);
  const body = { ...scopeDefaults(command, args, values), ...command.body };
  for (const [parameter, field] of Object.entries(command.parameter_fields ?? {})) {
    const value = values[parameter];
    if (parameter === 'path') {
      if (!value || !isSafeRelativePath(value)) throw new RunnerError('usage', 'Provide a safe repository-relative file path.');
      body[field] = value;
    } else body[field] = decodeURIComponent(identifier(value, parameter));
  }
  const path = command.path.replace(/\{([a-z_]+)\}/g, (_match, name: string) => identifier(values[name], name === 'repo' ? 'repository ID (--repo)' : name === 'account' ? 'account ID (--account)' : name));
  return sendApi(await resolveFieldScopes(command, args, values), io, signal, { method: command.method, path, fields: command.fields, body, watch: command.watch });
}
